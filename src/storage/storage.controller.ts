import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { JobStoreService } from './job-store.service';
import { StorageService } from './storage.service';
import { CopyJobPayload } from './storage.types';

@Controller('storage')
export class StorageController {
  constructor(
    private readonly storage: StorageService,
    private readonly jobs: JobStoreService,
  ) {}

  @Get('areas')
  getAreas() {
    return { areas: this.storage.areas() };
  }

  @Get('capacity')
  capacity() {
    return this.storage.capacity();
  }

  @Get(':area/list')
  list(@Param('area') area: string, @Query('path') path = '') {
    return this.storage.list(area, path);
  }

  @Get(':area/stat')
  stat(@Param('area') area: string, @Query('path') path: string) {
    return this.storage.stat(area, path);
  }

  @Post('jobs/copy-file')
  createCopy(@Body() payload: CopyJobPayload) {
    return this.jobs.createCopy(payload);
  }

  @Get('jobs/:id')
  async getJob(@Param('id') id: string) {
    const job = await this.jobs.get(id);
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }
}
