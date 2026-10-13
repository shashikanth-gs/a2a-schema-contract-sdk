"""Default validation infrastructure; optional protocol adapters are not loaded."""

from .jsonschema import JsonSchemaEngine, validate_structure, validate_value

__all__ = ["JsonSchemaEngine", "validate_structure", "validate_value"]
