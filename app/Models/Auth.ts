import { column, BaseModel, computed } from "@ioc:Adonis/Lucid/Orm";

export default class Auth extends BaseModel {
  public static table = "Users";

  @column({ isPrimary: true })
  public UserId: string;

  @column()
  public UserTypeId: number;

  @column()
  public UserStatusId: number;

  @column()
  public Password: string;
}
