import { BaseModel, ClientModel, Property, ReferenceCollection, LoadStrategy } from "sync-engine";
import type { LazyReferenceCollection } from "sync-engine";
import type { Issue } from "./Issue";
import { dateSerializer, dateDeserializer } from "./serializers";

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class Team extends BaseModel {
  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public createdAt: Date = new Date();

  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public updatedAt: Date = new Date();

  @Property()
  public name = "";

  @Property()
  public key = "";

  @ReferenceCollection("Issue", { lazy: true })
  public issues: LazyReferenceCollection<Issue>;
}
