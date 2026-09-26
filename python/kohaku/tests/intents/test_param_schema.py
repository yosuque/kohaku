"""Tests for ObjectSchema.validate (unlike parse/safe_parse, collects every field's issue instead of
stopping at the first). Added alongside sales_api's IntentCatalog.validate_params (t0-3b), which uses it to
back SalesSemanticPort.validate_intent.
"""

from __future__ import annotations

from kohaku.intents import EnumField, ObjectSchema, number, object_schema, string


def _schema() -> ObjectSchema:
    return object_schema(
        {
            "region": EnumField(values=("japan", "north_america")),
            "topN": number(integer=True, minimum=1, maximum=20).default(5),
            "q": string().optional(),
        }
    )


class TestValidate:
    def test_accepts_valid_params_and_fills_defaults(self) -> None:
        result = _schema().validate({"region": "japan"})
        assert result.success is True
        assert result.data == {"region": "japan", "topN": 5}
        assert result.issues == []

    def test_a_missing_required_field_is_one_issue(self) -> None:
        result = _schema().validate({})
        assert result.success is False
        assert result.data is None
        assert [i.path for i in result.issues] == ["region"]
        assert "region" in result.issues[0].message

    def test_an_invalid_enum_value_is_one_issue_scoped_to_its_key(self) -> None:
        result = _schema().validate({"region": "mars"})
        assert result.success is False
        assert len(result.issues) == 1
        assert result.issues[0].path == "region"

    def test_collects_every_fields_issue_unlike_safe_parse_which_stops_at_the_first(self) -> None:
        schema = _schema()
        # safe_parse (the pre-existing, single-error API) only ever reports one problem even when two
        # fields are simultaneously invalid.
        single = schema.safe_parse({"region": "mars", "topN": 999})
        assert single.success is False
        assert single.error is not None
        # validate collects both.
        result = schema.validate({"region": "mars", "topN": 999})
        assert result.success is False
        assert {i.path for i in result.issues} == {"region", "topN"}

    def test_an_optional_field_missing_is_dropped_not_an_issue(self) -> None:
        result = _schema().validate({"region": "japan"})
        assert result.success is True
        assert result.data is not None
        assert "q" not in result.data
