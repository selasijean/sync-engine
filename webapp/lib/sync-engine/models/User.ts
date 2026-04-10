import { BaseModel } from "../core/BaseModel";
import { ClientModel, Property, EphemeralProperty } from "../core/decorators";
import { LoadStrategy } from "../core/types";
import { dateSerializer, dateDeserializer } from "./serializers";

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class User extends BaseModel {
  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public createdAt: Date = new Date();

  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public updatedAt: Date = new Date();

  @Property()
  public name = "";

  @Property()
  public email = "";

  @EphemeralProperty()
  public lastUserInteraction: Date | null = null;
}
