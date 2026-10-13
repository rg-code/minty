// The demo's stand-in for jose: its Access check runs with MINTY_DEV_NO_AUTH on a localhost
// request (it never leaves the page), so no Access JWT is ever verified.
const never = () => { throw new Error("the demo verifies no Access JWTs"); };
export const createRemoteJWKSet = never;
export const jwtVerify = never;
