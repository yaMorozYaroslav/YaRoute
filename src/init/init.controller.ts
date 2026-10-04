import { Body, Controller, Post } from '@nestjs/common';
import { InitService } from './init.service';
import { InitInput } from './init.types';

@Controller('init')
export class InitController {
  constructor(private readonly init: InitService) {}

  @Post()
  initialize(@Body() body: InitInput) {
    return this.init.initialize(body ?? {});
  }
}
