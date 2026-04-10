import { BaseModel } from "../core/BaseModel";
import { ClientModel, Property, Reference } from "../core/decorators";
import { LoadStrategy } from "../core/types";
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
