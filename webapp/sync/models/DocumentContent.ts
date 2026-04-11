import { BaseModel, ClientModel, Property, Reference, LoadStrategy } from "sync-engine";
import type { Issue } from "./Issue";

@ClientModel({ loadStrategy: LoadStrategy.Partial })
export class DocumentContent extends BaseModel {
  @Property({ lazy: true })
  public content = "";

  @Property({ indexed: true })
  public issueId = "";

  @Reference("Issue")
  public issue: Issue;
}
