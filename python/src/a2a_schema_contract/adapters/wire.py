"""Strict original JSON admission using the public protobuf field descriptors.

Protobuf's JSON parser tolerates null, aliases and unknown fields. Validate before
calling it, including oneof cardinality, enum names and exact scalar carrier types.
Business validation remains in the protocol-independent application services.
"""

import base64
import binascii
from typing import cast

from google.protobuf.descriptor import Descriptor, FieldDescriptor
from google.protobuf.message import Message
from google.protobuf.timestamp_pb2 import Timestamp

from ..binding import reject
from ..core import ErrorContext, JsonValue, snapshot


def admit(value: object, model: type[Message]) -> dict[str, JsonValue]:
    data = snapshot(value, ErrorContext("remote"))
    if not isinstance(data, dict):
        reject()
    _message(data, cast("Descriptor", model.DESCRIPTOR))
    return data


def _message(value: JsonValue, descriptor: Descriptor) -> None:
    if descriptor.full_name in ("google.protobuf.Value", "google.protobuf.Struct"):
        if descriptor.full_name.endswith("Struct") and not isinstance(value, dict):
            reject()
        return
    if descriptor.full_name == "google.protobuf.Timestamp":
        if not isinstance(value, str):
            reject()
        try:
            Timestamp().FromJsonString(value)
        except (ValueError, OverflowError):
            reject()
        return
    if not isinstance(value, dict):
        reject()
    fields = {field.json_name: field for field in descriptor.fields}
    if value.keys() - fields.keys():
        reject()
    seen: set[str] = set()
    for name, item in value.items():
        field = fields[name]
        if field.containing_oneof is not None:
            group = field.containing_oneof.name
            if group in seen:
                reject()
            seen.add(group)
        if field.is_repeated:
            if field.message_type is not None and field.message_type.GetOptions().map_entry:
                if not isinstance(item, dict):
                    reject()
                mapped = field.message_type.fields_by_name["value"]
                for child in item.values():
                    _field(child, mapped)
            else:
                if not isinstance(item, list):
                    reject()
                for child in item:
                    _field(child, field)
        else:
            _field(item, field)


def _field(value: JsonValue, field: FieldDescriptor) -> None:
    if field.message_type is not None:
        _message(value, field.message_type)
    elif field.enum_type is not None:
        if not isinstance(value, str) or value not in field.enum_type.values_by_name:
            reject()
    elif field.type == FieldDescriptor.TYPE_BOOL:
        if type(value) is not bool:
            reject()
    elif field.type in (FieldDescriptor.TYPE_STRING, FieldDescriptor.TYPE_BYTES):
        if not isinstance(value, str):
            reject()
        if field.type == FieldDescriptor.TYPE_BYTES:
            try:
                if base64.b64encode(base64.b64decode(value, validate=True)).decode() != value:
                    reject()
            except (ValueError, binascii.Error):
                reject()
    elif field.type in (FieldDescriptor.TYPE_FLOAT, FieldDescriptor.TYPE_DOUBLE):
        if type(value) not in (int, float):
            reject()
    elif type(value) not in (int, float) or not float(cast("int | float", value)).is_integer():
        reject()
    else:
        bits = 64 if field.type in (3, 4, 6, 16, 18) else 32
        unsigned = field.type in (4, 6, 7, 13)
        lower, upper = (0, 2**bits - 1) if unsigned else (-(2 ** (bits - 1)), 2 ** (bits - 1) - 1)
        if not lower <= cast("int | float", value) <= upper:
            reject()
