import { Injectable } from '@nestjs/common';
import { GithubWriteConnector } from '../connectors/github-writes';
import { NyxBootstrapService } from '../nyx/bootstrap.service';
import { NyxCliRegistryService } from '../nyx/cli-registry.service';
import { NyxExecutionProfileService } from '../nyx/execution-profile.service';
import { ReviewedPin, reconcileRuntimePins, textHash } from '../nyx/runtime-pin-repair';

@Injectable()
export class RuntimeMaintenanceService {
  constructor(private readonly bootstrap: NyxBootstrapService,
    private readonly registry: NyxCliRegistryService,
    private readonly profiles: NyxExecutionProfileService,
    private readonly github: GithubWriteConnector) {}

  private privateOnly() {
    if (process.env.NYX_DEPLOYMENT_MODE === 'public') throw new Error('MAINTENANCE_PRIVATE_ONLY');
  }
  private async snapshot(owner:string,id:string,repo:string,testerSha:string) {
    this.privateOnly();
    const file=await this.github.readTesterRuntimeProfile(owner,id,repo,testerSha);
    const locator=await this.bootstrap.locate();
    const authority=await this.registry.current(locator);
    const preflight=await this.profiles.inspectMaintenanceTarget(locator,file.text,authority.hash);
    return {file,locator,authority,preflight};
  }
  async inspect(owner:string,id:string,repo:string,testerSha:string) {
    const snapshot=await this.snapshot(owner,id,repo,testerSha);
    return {
      schema:'nyx.maintenance.runtime-pins.v1',
      status:snapshot.preflight.ready && !('driftDetected' in snapshot.preflight && snapshot.preflight.driftDetected)?'PINS_VERIFIED':
        ('authorityMatches' in snapshot.preflight && snapshot.preflight.authorityMatches &&
          snapshot.preflight.keys.every(pin=>'actual' in pin))?'REVIEW_REQUIRED':'BLOCKED',
      target:{repo,base:'tester',sha:testerSha},
      expectedProfileSha256:textHash(snapshot.file.text),
      expectedCliSha256:snapshot.authority.hash,
      bootstrapCanonical:snapshot.locator.canonical,
      canonicalFreshness:'bootstrap-pointer-only; newest Footer not independently checked',
      preflight:snapshot.preflight,verifiedAt:new Date().toISOString(),
      mutation:'none',
    };
  }
  async prepare(owner:string,input:{id:string;repo:string;expectedTesterSha:string;
    reviewBranch:string;expectedProfileSha256:string;expectedCliSha256:string;reviewedKeys:ReviewedPin[]}) {
    const {id,repo,expectedTesterSha}=input;
    const snapshot=await this.snapshot(owner,id,repo,expectedTesterSha);
    if (textHash(snapshot.file.text)!==input.expectedProfileSha256)
      throw new Error('MAINTENANCE_PROFILE_CHANGED');
    if (snapshot.authority.hash!==input.expectedCliSha256)
      throw new Error('MAINTENANCE_CLI_AUTHORITY_CHANGED');
    const keys=snapshot.preflight.keys;
    if ('error' in snapshot.preflight || !('authorityMatches' in snapshot.preflight) ||
        !snapshot.preflight.authorityMatches || !keys.length || keys.length>32 ||
        !Array.isArray(input.reviewedKeys) || input.reviewedKeys.length!==keys.length ||
        new Set(input.reviewedKeys.map(pin=>pin.key)).size!==keys.length ||
        keys.some(pin=> !('actual' in pin) || !input.reviewedKeys.some(
          reviewed=>reviewed.key===pin.key && reviewed.sha256===pin.actual))) {
      throw new Error('MAINTENANCE_LIVE_PINS_CHANGED_OR_UNAVAILABLE');
    }
    const proposal=reconcileRuntimePins(snapshot.file.text,input.reviewedKeys,snapshot.authority.hash);
    if (!proposal.changes.length) return {status:'NO_CHANGE',merged:false,deployed:false};
    const stage=await this.github.stageRuntimePinRepair(owner,id,repo,input.reviewBranch,
      expectedTesterSha,snapshot.file.text,proposal.content);
    // Branch creation has a verified receipt even if subsequent PR creation fails.
    try {
      const pr=await this.github.draftPullToNonDefault(owner,id,repo,input.reviewBranch,'tester',
        'Reconcile reviewed NYX runtime key pins',
        'Pin-only runtime repair. Live sources were read and matched the explicitly reviewed hashes. '+
        'CLI, source refs, command contracts and permissions are unchanged. '+
        'Canonical Footer freshness and adapter compatibility require separate verification. '+
        'No deployment, initialization or credential retirement is claimed.');
      return {status:'DRAFT_REVIEW_READY',...stage,pr};
    } catch {
      return {status:'BRANCH_VERIFIED_PR_PENDING',...stage,
        next:'Create the tester review PR using the verified branch receipt.'};
    }
  }
}
