import UserType from "App/Enums/UserType";
import User from "App/Models/User";
import ErrorMessage from "App/Modules/ErrorMessage";
import Validation from "App/Modules/Validation";
import Env from "@ioc:Adonis/Core/Env";
import { DateTime } from "luxon";
import Redis from "@ioc:Adonis/Addons/Redis";
import PendingSignup from "App/Models/Redis/PendingSignup";
import Hash from "@ioc:Adonis/Core/Hash";
import { EmailUtils } from "App/Modules/emailutils";
import { generateCode } from "App/Modules/stringutils";
import UserStatus from "App/Enums/UserStatus";

export default class AuthController {
  public async checkEmail({ request, response }) {
    const email = request.input("email")?.toLowerCase().trim();
    const userType = parseInt(request.input("userType"));
    if (!Object.values(UserType).includes(userType)) {
      return response.badRequest();
    }

    if (Validation.validateEmail(email))
      return response.badRequest(ErrorMessage.Auth.InvalidEmail);

    const matchedUser = await User.findBy("Email", email);
    const emailExists = !!matchedUser;
    if (!matchedUser) {
      return { emailExists };
    }

    if (matchedUser.UserTypeId !== userType) {
      return response.badRequest(ErrorMessage.Auth.PasswordTooShort);
    }
    return { emailExists };
  }

  public async signUp({ request, response }) {
    const email = request.input("email")?.toLowerCase().trim();
    const password = request.input("password");
    if (!Validation.validateEmail(email))
      return response.badRequest(ErrorMessage.Auth.InvalidEmail);
    if (password?.length < 6)
      return response.badRequest(ErrorMessage.Auth.PasswordTooShort);
    if (password?.length > 128)
      return response.badRequest(ErrorMessage.Auth.PasswordTooLong);

    const codeLength = Env.get("VERIFICATION_CODE_LENGTH") as number;
    const codeExpiry =
      (Env.get("VERIFICATION_CODE_EXPIRY_MINUTES") as number) * 60;
    const codeCooldown = Env.get(
      "VERIFICATION_CODE_COOLDOWN_MINUTES"
    ) as number;
    const passwordHash = await Hash.make(password);
    const existingUser = await User.findBy("Email", email);
    if (!!existingUser) return response.conflict(ErrorMessage.Auth.EmailInUse);

    //Check if user has pending sign up on Redis
    const signupKey = `signup:${email}`;
    const existingPendingSignup = await Redis.get(signupKey);
    if (!existingPendingSignup) {
      console.log("no user found");
      //Create pending sign up record on Redis, make it valid for code_expiry minutes
      const newUser = new PendingSignup({
        Email: email,
        Password: passwordHash,
        Code: generateCode(codeLength),
        DateCreated: DateTime.utc().toMillis(),
      });
      Redis.set(signupKey, JSON.stringify(newUser));
      Redis.expire(signupKey, codeExpiry);
      EmailUtils.sendSignupVerificationMail(email, newUser.Code);
      return response.created();
    }

    //Update user pending signup record if exists
    console.log("user found");
    const existingSignup: PendingSignup = <PendingSignup>(
      JSON.parse(existingPendingSignup)
    );
    existingSignup.Password = passwordHash;

    //if code is sent within code_cooldown minutes, retain old code
    const isSentWithinCooldown =
      DateTime.utc().toMillis() - existingSignup.DateCreated <
      codeCooldown * 60 * 1000;
    if (isSentWithinCooldown) {
      Redis.set(signupKey, JSON.stringify(existingSignup));
      Redis.expire(signupKey, codeExpiry);
      const secondsBeforeResend = Math.round(
        codeCooldown * 60 -
          (DateTime.utc().toMillis() - existingSignup.DateCreated) / 1000
      );
      return response.ok({
        secondsBeforeResend,
      });
    }

    //otherwise create new code and refresh expiry
    console.log("code is old");
    existingSignup.Code = generateCode(codeLength);
    existingSignup.DateCreated = DateTime.utc().toMillis();
    Redis.set(signupKey, JSON.stringify(existingSignup));
    Redis.expire(signupKey, codeExpiry);
    //then send verification email
    EmailUtils.sendSignupVerificationMail(email, existingSignup.Code);
    return response.created();
  }

  public async verify({ auth, request, response }) {
    const code = request.input("code");
    const email = request.input("email")?.toLowerCase().trim();

    const signupKey = `signup:${email}`;
    const matchedSignup = await Redis.get(signupKey);
    if (!matchedSignup) {
      return response.unauthorized(ErrorMessage.Auth.CodeInvalid);
    }

    const matchedSignupUser = <PendingSignup>JSON.parse(matchedSignup);
    if (matchedSignupUser.Code !== code) {
      console.log("user found but code invalid");
      return response.unauthorized(ErrorMessage.Auth.CodeInvalid);
    }

    //Delete pending signup record in Redis and create user in DB
    Redis.del(signupKey);
    const { Email, Password } = matchedSignupUser;
    const newUser = await new User()
      .merge({
        shouldHashPassword: false,
        Email,
        UserStatusId: UserStatus.PendingSetup,
        UserTypeId: UserType.Customer,
        Password,
      })
      .save();
    const token = await auth.use("api").generate(newUser);
    return response.created({ token });
  }
  public async signIn({ auth, request, response }) {
    const email = request.input("email")?.toLowerCase().trim();
    const password = request.input("password");

    //Find matching user
    const user = await User.findBy("Email", email);
    if (!user)
      return response.unauthorized(ErrorMessage.Auth.InvalidCredentials);

    //Get stuff from user
    const { UserStatusId: userStatus } = user;
    const isPasswordValid = await Hash.verify(user.Password, password);
    if (!isPasswordValid) {
      return response.unauthorized(ErrorMessage.Auth.InvalidCredentials);
    }

    // verified
    const token = await auth.use("api").generate(user);

    return {
      userStatus,
      token,
    };
  }
}