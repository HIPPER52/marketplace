import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/decorators/principal.decorator';
import type { Principal } from '../../auth/types/auth.types';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import type {
    CommitUploadRequest,
    CreateUploadIntentRequest,
    StoredFileResponse,
    UploadIntent,
} from '../../common/types/api.types';
import type { AllowedContentType } from '../constants/content-type.constant';
import { GET_EXPIRES_SEC } from '../constants/storage.constant';
import { FilesRepository } from '../repositories/files.repository';
import { Presigner } from '../services/presigner.service';
import { UploadsService } from '../services/uploads.service';
import { toApiFile, toApiIntent } from '../utils/file.mapper';

@Controller()
export class UploadsController {
    constructor(
        private readonly uploads: UploadsService,
        private readonly files: FilesRepository,
        private readonly presigner: Presigner,
    ) {}

    /**
     * Step one. Answers with a key the server composed and a grant the store will check.
     *
     * `filename` is accepted and deliberately unused beyond display: the contract says so
     * out loud, and `demo:upload` sends `../../etc/passwd` to prove it goes nowhere.
     */
    @Post('uploads/intent')
    @HttpCode(200)
    async intent(
        @CurrentUser() me: Principal,
        @Body() body: CreateUploadIntentRequest,
    ): Promise<UploadIntent> {
        // The validator has already held the body to the spec's enum, so the cast is a
        // statement about where the narrowing happened rather than an assumption.
        const granted = await this.uploads.intent({
            ownerId: me.userId,
            contentType: body.content_type as AllowedContentType,
            sizeBytes: body.size_bytes,
        });

        return toApiIntent(granted);
    }

    /** Step two, and the one that asks the store instead of the client. */
    @Post('uploads/commit')
    @HttpCode(200)
    async commit(
        @CurrentUser() me: Principal,
        @Body() body: CommitUploadRequest,
    ): Promise<StoredFileResponse> {
        return toApiFile(await this.uploads.commit(body.file_id, me.userId));
    }

    /**
     * A redirect, not a proxy.
     *
     * The guard above runs on every request, so access is decided now rather than when a
     * link was mailed — which is the only revocation a presigned URL admits. And the
     * bytes still go from the store straight to the client: this service is in the
     * authorisation path and out of the data path.
     *
     * Written against `@Res()` because a 302 with no body is not what a Nest handler
     * returning an object produces, and because `GET_EXPIRES_SEC` belongs on the header
     * rather than in a guess.
     */
    @Get('files/:fileId')
    async download(
        @CurrentUser() me: Principal,
        @Param('fileId') fileId: string,
        @Res() res: Response,
    ): Promise<void> {
        const row = await this.files.findById(fileId);

        if (row === null) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No file with id ${fileId}.`,
            });
        }

        if (row.ownerId !== me.userId) {
            throw new ProblemError({
                status: 403,
                type: ProblemType.forbidden,
                title: 'Forbidden',
                detail: `File ${fileId} does not belong to you.`,
            });
        }

        res.redirect(302, await this.presigner.get(row.objectKey, GET_EXPIRES_SEC));
    }
}
