/** 从既有界面模型导出本地业务种子；不执行浏览器代码或改变界面文件。 */
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'caixiaozhi-seed-'));
try {
  const outfile = join(temporary, 'seed.mjs');
  await build({
    stdin: { contents: `
      import { documentInitialData, materialsInitial } from './apps/web/src/demos/agent-workspace/Documents';
      import { INITIAL_RULES_SUBMISSION, AUDIT_DOCUMENTS } from './apps/web/src/demos/agent-workspace/RulesSubmission';
      import { readRuleCenter } from './apps/web/src/demos/agent-workspace/rule-center-model';
      import { readSubmissionState } from './apps/web/src/demos/agent-workspace/submission-state';
      import { expenseCategories } from './apps/web/src/demos/agent-workspace/submission-model';
      import { analysisRows } from './apps/web/src/demos/agent-workspace/analytics-model';
      import { policies } from './apps/web/src/demos/agent-workspace/Supporting';
      import { initialHub } from './apps/web/src/demos/agent-workspace/Skills';
      export default { data: {
        documents: documentInitialData.map(d=>({...d, synthetic:true, details:[...d.details,{label:'数据来源',value:'本地合成业务数据'}]})),
        documentSources:{states:{oa:'ready',expense:'ready'}},
        analysisRecords:[...analysisRows({month:'09'}),...analysisRows({month:'10'})],
        policies:policies.map(p=>({...p,synthetic:true,source:'本地合成制度'})),
        skillsHub:initialHub,
        rulesSubmission:{...INITIAL_RULES_SUBMISSION,reviewedAt:{expense:'',oa:''},schedule:{enabled:false,time:'08:30'}},
        srsRuleCenterV1:readRuleCenter({}),
        submissions:readSubmissionState({}),
        materials:{...materialsInitial,files:materialsInitial.files.map(f=>({...f,synthetic:true,source:'本地合成材料'}))},
        auditDocuments:AUDIT_DOCUMENTS,
        expenseCategories,
        receipts:{},submissionLedger:{}
      }, tasks:[], activeTask:null };
    `, resolveDir: root, loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'dataurl' },
    plugins: [{ name: 'expose-skill-seed', setup(api:any) {
      api.onLoad({filter:/\/agent-workspace\/Skills\.tsx$/},async (args:any)=>({
        contents:(await readFile(args.path,'utf8'))+'\nexport {initialHub};',loader:'tsx',resolveDir:resolve(args.path,'..')
      }));
    }}],
  });
  const { default: seed } = await import(pathToFileURL(outfile).href);
  await writeFile(resolve(root,'apps/agno-service/seed.json'),JSON.stringify(seed,null,2)+'\n');
  console.log('已导出本地业务种子：'+seed.data.documents.length+' 张单据。');
} finally { await rm(temporary,{recursive:true,force:true}); }
