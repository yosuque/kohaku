"""Schema models for UI Spec / SpecPatch (port of packages/spec-core/src/schema/*.ts).

Semantic mapping to zod:
- zod's default (strip) = pydantic extra="ignore" (unknown keys are silently dropped)
- zod .strict() = extra="forbid" (DataRef / BindParam / SandboxArtifactRef / predicate nodes)
- zod .optional() means "allow key absence but reject explicit null" — reproduced with a before validator
- zod .default() is filled at parse time (props={} / events=[])
- fields whose wire name is a Python keyword/symbol use an alias ($ref / $state / in / not / from)

Serialization is done via to_wire() (explicit dict assembly) to guarantee the same shape as a TS parsed
object (defaults filled, absent keys omitted, SpecPatch nulls kept).
"""

from __future__ import annotations

from typing import Annotated, Any, ClassVar, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

# --- Protocol version (schema/spec.ts) ---

SPEC_VERSION: Literal["0.2"] = "0.2"
"""The protocol version issued. Newly composed Specs declare this version."""

ACCEPTED_SPEC_VERSIONS: tuple[str, ...] = ("0.1", "0.2")
"""The set of accepted versions ("issue 0.2 and accept {0.1, 0.2}")."""

SANDBOX_HTML_TYPE = "sandbox.html"
"""Reserved component type representing L2 freely generated HTML."""

MAX_PREDICATE_DEPTH = 8
"""Maximum nesting depth of a composite predicate (a single leaf is depth 1)."""

MAX_PREDICATE_ITEMS = 16
"""Maximum length of the element array of all / any."""

# --- Patterns (identical to zod .regex) ---

COMPONENT_ID_PATTERN = r"^[a-zA-Z][a-zA-Z0-9_-]{0,63}$"
CANONICAL_NAME_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$"
INTENT_HASH_PATTERN = r"^sha256:[0-9a-f]{64}$"
# The trailing $ and [^#] forbid a # fragment, aligning the grammar with query_ref.parse_query_ref.
DATA_REF_PATTERN = r"^query://[a-z0-9_-]+/[^#]+$"
SHA256_HEX_PATTERN = r"^[0-9a-f]{64}$"
STATE_KEY_PATTERN = r"^[a-zA-Z][a-zA-Z0-9_]{0,63}$"
STATE_REF_PATTERN = r"^\$state\.[a-zA-Z][a-zA-Z0-9_]{0,63}$"
EVENT_ON_PATTERN = r"^[a-zA-Z][a-zA-Z0-9_-]*\.[a-zA-Z][a-zA-Z0-9]*$"
# zod z.iso.datetime() default (no offset, Z required, arbitrary-precision fractional seconds).
ISO_DATETIME_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$"

ComponentId = Annotated[str, StringConstraints(pattern=COMPONENT_ID_PATTERN)]
StateKey = Annotated[str, StringConstraints(pattern=STATE_KEY_PATTERN)]

# --- JSON values (schema/json.ts) ---

type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]
"""Only JSON values may be placed in a UI Spec's props / params (a Spec is "data, not code")."""

type JsonObject = dict[str, JsonValue]


class _WireModel(BaseModel):
    """Common config: accept aliases + zod strip equivalent (ignore unknown keys) + reject explicit null for optionals."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    # zod .optional() allows only undefined (key absence) and rejects explicit null.
    # If a key listed here exists in the input dict with null, raise an error.
    _NON_NULLABLE_OPTIONALS: ClassVar[tuple[str, ...]] = ()

    @model_validator(mode="before")
    @classmethod
    def _reject_explicit_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in cls._NON_NULLABLE_OPTIONALS:
                if key in data and data[key] is None:
                    raise ValueError(f'"{key}" must not be null (omit the key instead)')
        return data


class _StrictWireModel(_WireModel):
    """Equivalent to zod .strict() (rejects unknown keys instead of stripping them)."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


# --- Intent (schema/intent.ts) ---


class Intent(_WireModel):
    """Normalized Intent. Both natural-language questions and GUI operations converge to this form.

    hash is the deterministic hash of canonical + params, the primary component of the cache key.
    """

    canonical: Annotated[str, StringConstraints(pattern=CANONICAL_NAME_PATTERN)]
    params: dict[str, JsonValue]
    hash: Annotated[str, StringConstraints(pattern=INTENT_HASH_PATTERN)]

    def to_wire(self) -> dict[str, Any]:
        return {"canonical": self.canonical, "params": self.params, "hash": self.hash}


# --- Client-local state / conditional display (schema/state.ts) ---

_LEAF_COMPARISON_FIELDS = ("eq", "ne", "in_", "gt", "lt", "gte", "lte", "exists")


class LeafPredicate(_StrictWireModel):
    """Leaf predicate. Consists of ref (the referenced state key) + exactly one comparison.

    - eq / ne: canonical equality of JSON values (null is also a valid comparison target; distinguished from unspecified).
    - in: canonical equality with one of a JSON-value array.
    - gt / lt / gte / lte: numeric comparison (false if the state value is not a number).
    - exists: whether the state value is other than null/undefined (true=present / false=absent).
    """

    ref: Annotated[str, StringConstraints(pattern=STATE_REF_PATTERN)]
    eq: JsonValue = None
    ne: JsonValue = None
    in_: list[JsonValue] | None = Field(default=None, alias="in")
    gt: float | None = None
    lt: float | None = None
    gte: float | None = None
    lte: float | None = None
    exists: bool | None = None

    # eq / ne take null as a valid value, so they are not in _NON_NULLABLE_OPTIONALS
    # ("whether it was specified" is judged by model_fields_set).
    _NON_NULLABLE_OPTIONALS: ClassVar[tuple[str, ...]] = (
        "in",
        "gt",
        "lt",
        "gte",
        "lte",
        "exists",
    )

    @model_validator(mode="after")
    def _exactly_one_comparison(self) -> LeafPredicate:
        specified = [f for f in _LEAF_COMPARISON_FIELDS if self._is_set(f)]
        if len(specified) != 1:
            raise ValueError(
                "a visibleWhen leaf must specify exactly one of"
                " eq / ne / in / gt / lt / gte / lte / exists"
            )
        return self

    def _is_set(self, field: str) -> bool:
        return field in self.model_fields_set

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"ref": self.ref}
        for field in _LEAF_COMPARISON_FIELDS:
            if self._is_set(field):
                wire_key = "in" if field == "in_" else field
                out[wire_key] = getattr(self, field)
        return out


class AllPredicate(_StrictWireModel):
    all: list[VisibleWhen] = Field(min_length=1, max_length=MAX_PREDICATE_ITEMS)

    def to_wire(self) -> dict[str, Any]:
        return {"all": [p.to_wire() for p in self.all]}


class AnyPredicate(_StrictWireModel):
    any: list[VisibleWhen] = Field(min_length=1, max_length=MAX_PREDICATE_ITEMS)

    def to_wire(self) -> dict[str, Any]:
        return {"any": [p.to_wire() for p in self.any]}


class NotPredicate(_StrictWireModel):
    not_: VisibleWhen = Field(alias="not")

    def to_wire(self) -> dict[str, Any]:
        return {"not": self.not_.to_wire()}


type VisibleWhen = LeafPredicate | AllPredicate | AnyPredicate | NotPredicate
"""Predicate node for conditional display (leaf or composite)."""


def predicate_depth(pred: VisibleWhen) -> int:
    """Nesting depth of the predicate tree (leaf = 1)."""
    if isinstance(pred, AllPredicate):
        return 1 + max(predicate_depth(p) for p in pred.all)
    if isinstance(pred, AnyPredicate):
        return 1 + max(predicate_depth(p) for p in pred.any)
    if isinstance(pred, NotPredicate):
        return 1 + predicate_depth(pred.not_)
    return 1


def _validate_predicate_depth(pred: VisibleWhen) -> VisibleWhen:
    """Equivalent to VisibleWhenSchema's superRefine (validates the nesting-depth limit)."""
    depth = predicate_depth(pred)
    if depth > MAX_PREDICATE_DEPTH:
        raise ValueError(
            f"visibleWhen is nested too deeply (depth {depth} > limit {MAX_PREDICATE_DEPTH})"
        )
    return pred


# --- Components (schema/component.ts) ---


class BindParam(_StrictWireModel):
    """One binding-sidecar parameter of two-way binding (kohaku >= 0.2 [Draft]).

    Substitutes the corresponding $ref parameter with the $state key's value to form the effective ref.
    values is the authorized value domain (discrete strings), the sole source of truth for capability variant enumeration.
    """

    state: StateKey = Field(alias="$state")
    values: list[str] = Field(min_length=1)

    def to_wire(self) -> dict[str, Any]:
        return {"$state": self.state, "values": list(self.values)}


class DataRef(_StrictWireModel):
    """Data is reference-passing only. Bulk data is never carried in a Spec.

    strict: keys other than $ref / bind (bulk contamination such as rows / columns) are rejected, not stripped.
    """

    ref: Annotated[str, StringConstraints(pattern=DATA_REF_PATTERN)] = Field(alias="$ref")
    bind: dict[Annotated[str, StringConstraints(min_length=1)], BindParam] | None = None

    _NON_NULLABLE_OPTIONALS: ClassVar[tuple[str, ...]] = ("bind",)

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"$ref": self.ref}
        if self.bind is not None:
            out["bind"] = {k: v.to_wire() for k, v in self.bind.items()}
        return out


class SandboxArtifactRef(_StrictWireModel):
    """Artifact of an L2 (freely generated) component. Exactly one of inline / uri. sha256 is for pre-mount validation."""

    inline: str | None = None
    uri: str | None = None
    sha256: Annotated[str, StringConstraints(pattern=SHA256_HEX_PATTERN)]

    _NON_NULLABLE_OPTIONALS: ClassVar[tuple[str, ...]] = ("inline", "uri")

    @model_validator(mode="after")
    def _exactly_one_source(self) -> SandboxArtifactRef:
        if (self.inline is not None) == (self.uri is not None):
            raise ValueError("artifact must have exactly one of inline / uri")
        return self

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.inline is not None:
            out["inline"] = self.inline
        if self.uri is not None:
            out["uri"] = self.uri
        out["sha256"] = self.sha256
        return out


class ComponentNode(_WireModel):
    """Component node in a flat list with ID references.

    Easy for an LLM to generate / revise, and suited to incremental updates and streaming.
    """

    id: ComponentId
    type: Annotated[str, StringConstraints(min_length=1)]
    version: str | None = None
    """Pins the catalog version composer resolved."""
    props: dict[str, JsonValue] = Field(default_factory=dict)
    children: list[ComponentId] | None = None
    data: DataRef | None = None
    artifact: SandboxArtifactRef | None = None
    visibleWhen: VisibleWhen | None = None
    """Conditional-display predicate (kohaku >= 0.2). If false, the Renderer does not render the entire subtree."""

    _NON_NULLABLE_OPTIONALS: ClassVar[tuple[str, ...]] = (
        "version",
        "children",
        "data",
        "artifact",
        "visibleWhen",
    )

    @field_validator("visibleWhen", mode="after")
    @classmethod
    def _check_depth(cls, v: VisibleWhen | None) -> VisibleWhen | None:
        return _validate_predicate_depth(v) if v is not None else None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "type": self.type}
        if self.version is not None:
            out["version"] = self.version
        out["props"] = self.props
        if self.children is not None:
            out["children"] = list(self.children)
        if self.data is not None:
            out["data"] = self.data.to_wire()
        if self.artifact is not None:
            out["artifact"] = self.artifact.to_wire()
        if self.visibleWhen is not None:
            out["visibleWhen"] = self.visibleWhen.to_wire()
        return out


# --- Events (schema/events.ts) ---


class EventBinding(_WireModel):
    """Event model. Returns operations within a component back to the Composition Service.

    payload allows runtime placeholder strings such as "$row.region".
    state.set is a kohaku >= 0.2 client-local state update (completed within the Renderer).
    """

    on: Annotated[str, StringConstraints(pattern=EVENT_ON_PATTERN)]
    emit: Literal["intent.patch", "intent.replace", "action.invoke", "state.set"]
    payload: dict[str, JsonValue]

    def to_wire(self) -> dict[str, Any]:
        return {"on": self.on, "emit": self.emit, "payload": self.payload}


# --- Provenance (schema/provenance.ts) ---


class ProvenanceFallback(_WireModel):
    """A trace that a component was downgraded during capability negotiation or repair."""

    from_: str = Field(alias="from")
    reason: str
    kind: Literal["generation", "negotiation"] | None = None
    """Kind of downgrade: generation = deterministic fallback after generation is exhausted / negotiation = capability negotiation."""

    _NON_NULLABLE_OPTIONALS: ClassVar[tuple[str, ...]] = ("kind",)

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"from": self.from_, "reason": self.reason}
        if self.kind is not None:
            out["kind"] = self.kind
        return out


class Provenance(_WireModel):
    """Provenance information directly tied to View Lineage. Records the tier, the composing agent, and cache hits."""

    tier: Literal["L0", "L1", "L2"]
    composedBy: str
    model: str | None = None
    cache: Literal["hit", "miss", "bypass", "fixated"]
    fallback: ProvenanceFallback | None = None
    composedAt: Annotated[str, StringConstraints(pattern=ISO_DATETIME_PATTERN)] | None = None

    _NON_NULLABLE_OPTIONALS: ClassVar[tuple[str, ...]] = ("model", "fallback", "composedAt")

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"tier": self.tier, "composedBy": self.composedBy}
        if self.model is not None:
            out["model"] = self.model
        out["cache"] = self.cache
        if self.fallback is not None:
            out["fallback"] = self.fallback.to_wire()
        if self.composedAt is not None:
            out["composedAt"] = self.composedAt
        return out


# --- UI Spec envelope (schema/spec.ts) ---


class UISpec(_WireModel):
    """UI Spec envelope. Carries no theme information (tokens are resolved on the Renderer side).

    The LLM generates only components / events; the envelope is filled by code.
    """

    kohaku: Literal["0.1", "0.2"]
    intent: Intent
    dataVersion: Annotated[str, StringConstraints(min_length=1)]
    refVersions: dict[str, str] | None = None
    """$ref URI → the dataVersion of that reference alone (for version reconciliation when dataVersion is `multi:`)."""
    state: dict[StateKey, JsonValue] | None = None
    """Initial values of client-local state (kohaku >= 0.2). Confined within the Renderer."""
    components: list[ComponentNode] = Field(min_length=1)
    events: list[EventBinding] = Field(default_factory=list)
    provenance: Provenance

    _NON_NULLABLE_OPTIONALS: ClassVar[tuple[str, ...]] = ("refVersions", "state")

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "kohaku": self.kohaku,
            "intent": self.intent.to_wire(),
            "dataVersion": self.dataVersion,
        }
        if self.refVersions is not None:
            out["refVersions"] = dict(self.refVersions)
        if self.state is not None:
            out["state"] = dict(self.state)
        out["components"] = [c.to_wire() for c in self.components]
        out["events"] = [e.to_wire() for e in self.events]
        out["provenance"] = self.provenance.to_wire()
        return out


# --- SpecPatch (schema/patch.ts) ---


class SpecPatch(_WireModel):
    """Component-level semantic patch (per-ID upsert/remove, not JSON Patch).

    Validates only the wire-form types and value ranges. Does not structurally validate a patch on its own
    (ID uniqueness / root required / acyclic) — validate_spec_structure runs inside apply_patch after
    application, so no double specification is created.

    refVersions / state are tri-state (key absent = no change / null = removal / dict = full replacement).
    "Whether it was specified" is judged by model_fields_set (is_field_set).
    """

    baseIntentHash: Annotated[str, StringConstraints(pattern=INTENT_HASH_PATTERN)]
    # Protocol version change (e.g. a 0.1 Spec promoted to 0.2 by a patch that also introduces `state`).
    # Absent = no version change (apply_patch keeps the target Spec's current `kohaku`). Present only when
    # diff_spec observes prev.kohaku != next.kohaku; otherwise the round-trip would lose the version change.
    kohaku: Literal["0.1", "0.2"] | None = None
    intent: Intent | None = None
    upsert: list[ComponentNode] | None = None
    remove: list[ComponentId] | None = None
    events: list[EventBinding] | None = None
    dataVersion: Annotated[str, StringConstraints(min_length=1)] | None = None
    refVersions: dict[str, str] | None = None
    state: dict[StateKey, JsonValue] | None = None
    provenance: Provenance | None = None

    _NON_NULLABLE_OPTIONALS: ClassVar[tuple[str, ...]] = (
        "kohaku",
        "intent",
        "upsert",
        "remove",
        "events",
        "dataVersion",
        "provenance",
    )

    def is_field_set(self, field: str) -> bool:
        """Whether the field was explicitly specified in the input (tri-state undefined / null discrimination)."""
        return field in self.model_fields_set

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"baseIntentHash": self.baseIntentHash}
        if self.kohaku is not None:
            out["kohaku"] = self.kohaku
        if self.intent is not None:
            out["intent"] = self.intent.to_wire()
        if self.upsert is not None:
            out["upsert"] = [c.to_wire() for c in self.upsert]
        if self.remove is not None:
            out["remove"] = list(self.remove)
        if self.events is not None:
            out["events"] = [e.to_wire() for e in self.events]
        if self.dataVersion is not None:
            out["dataVersion"] = self.dataVersion
        if self.is_field_set("refVersions"):
            out["refVersions"] = dict(self.refVersions) if self.refVersions is not None else None
        if self.is_field_set("state"):
            out["state"] = dict(self.state) if self.state is not None else None
        if self.provenance is not None:
            out["provenance"] = self.provenance.to_wire()
        return out


# --- Persistence records (schema/persistence.ts) ---
#
# Runtime (pydantic) counterparts of ports.py's dataclasses FixationRecord / PromotionState /
# LineageEventRecord, mirroring TS spec-core's zod schemas of the same name. `ports.StoragePort` returns
# these dataclasses with no runtime guarantee of their own — a corrupted or hand-edited persisted record
# (fixations.json / promotions.json) can violate the dataclass's declared shape without Python ever
# noticing, since dataclass field types are not checked at construction time. These models exist to be run
# against a record read back from storage at the read boundary (kohaku.lineage's Fixations service /
# CandidateStore.load), the same pattern as TS's FixationRecordSchema.safeParse / PromotionStateSchema.safeParse
# (see ports.py's validate_fixation_record / validate_promotion_state, which return the validated dataclass
# or None on failure).


class _PersistedPrincipalModel(_WireModel):
    """Runtime counterpart of ports.py's Principal, scoped to this file the same way as TS's local,
    unexported PersistedPrincipalSchema."""

    id: str
    name: str | None = None
    roles: list[str] | None = None


class _LineageActorModel(_WireModel):
    kind: Literal["user", "model", "system"]
    id: str | None = None
    model: str | None = None


class FixationRecordModel(_WireModel):
    """Runtime counterpart of ports.py's FixationRecord. See the section docstring above."""

    intentHash: str
    canonical: str
    structureHash: str
    pinnedSpec: UISpec
    fixatedAt: str
    approver: _PersistedPrincipalModel
    catalogFingerprint: str | None = None
    tenant: str | None = None
    revision: str | None = None


class PromotionStateModel(_WireModel):
    """Runtime counterpart of ports.py's PromotionState. `data` stays a loose JSON object rather than a
    closed shape — see TS PromotionStateSchema's doc comment (packages/spec-core/src/schema/persistence.ts)
    for why."""

    artifactId: str
    status: str
    updatedAt: str
    data: JsonObject = Field(default_factory=dict)
    tenant: str | None = None


class LineageEventRecordModel(_WireModel):
    """Runtime counterpart of ports.py's LineageEventRecord. Deliberately loose on `type` (a plain string)
    and `payload` (JsonObject): the event vocabulary is owned by kohaku.lineage, not kohaku.spec. Exported
    for parity with TS's LineageEventRecordSchema; not currently wired into a lineage read-boundary check
    (see that schema's TS doc comment)."""

    id: str
    ts: str
    actor: _LineageActorModel
    type: str
    payload: JsonObject = Field(default_factory=dict)
    tenant: str | None = None


# Resolve forward references of the recursive type (VisibleWhen).
AllPredicate.model_rebuild()
AnyPredicate.model_rebuild()
NotPredicate.model_rebuild()
ComponentNode.model_rebuild()
