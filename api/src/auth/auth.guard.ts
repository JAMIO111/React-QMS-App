import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/api-error';
import type { ApiRequest } from '../common/request-context';
import { JwtVerifier } from './jwt-verifier.service';

const PUBLIC = 'qms:public';
/** Marks a route as reachable without a token (e.g. health). Everything else requires sign-in. */
export const Public = () => SetMetadata(PUBLIC, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: JwtVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const header = req.headers.authorization;
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match) throw ApiError.unauthenticated();
    req.user = await this.verifier.verify(match[1]);
    return true;
  }
}
