import { run, PipelineResult } from './pipeline';
import { writeFileSync } from 'fs';
import 'dotenv/config';

// ====== 千问 API 调用封装 ======
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY!;

async function callQwen(
  system: string,
  user: string,
  model: string = ' qwen-max-latest ',
): Promise<string> {
  const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DASHSCOPE_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      // 留出充足空间给长 manifest
      max_tokens:  8192,
      extra_body: {
    enable_thinking: true
  }
    }),
  });

  const data = await response.json();

  if (!data.choices || data.choices.length === 0) {
    console.error('API Error Response:', JSON.stringify(data, null, 2));
    throw new Error(`API error: ${data.message || JSON.stringify(data)}`);
  }

  return data.choices[0].message.content as string;
}

// ====== 测试场景 ======
// ====== 测试场景 ======

const testCases: { name: string; input: string }[] = [
  {
    name: 'bridge',
    input: `五件混凝土构件：立柱两根，截面长零点五、宽零点五、高八，分置于横轴负五、高度四、纵轴零与横轴正五、高度四、纵轴零；横梁一根，长十二、厚零点三、深二，置于横轴零、高度四、纵轴零；基础两座，长一点五、高一、宽一点五，分置于横轴负八、高度零点五、纵轴零与横轴正八、高度零点五、纵轴零。全部零度朝向。`,
  },
  {
    name: 'building',
    input: `混凝土基础长二十、厚零点五、深十五，位于横轴零、高度零点二五、纵轴零。其上混凝土楼板长十六、厚零点三、深十二，位于高度零点六五。玻璃大堂长十四、高四、深十，位于高度二点八。混凝土雨棚长十八、厚零点二、深三，向纵轴负六点五延伸，中心高度四点一。九根混凝土立柱，截面长零点四、宽零点四、高十五，以三乘三网格排列：横轴坐标依次为负八、负一点三、五点四，纵轴坐标依次为负六、负一、四，各立柱中心高度七点五。二层楼板长十八、厚零点三、深十三，位于高度四点三五、纵轴零点五；其南面玻璃幕墙长十八、高三点五、厚零点零八，位于高度六点二五、纵轴负六；东面幕墙厚零点零八、高三点五、深十三，位于横轴九、高度六点二五、纵轴零点五。三层楼板长十九、厚零点三、深十四，位于高度八点零五、纵轴零点五；南面幕墙长十九、高三点五、厚零点零八，位于高度九点九五、纵轴负六点五；东面幕墙厚零点零八、高三点五、深十四，位于横轴九点五、高度九点九五、纵轴零点五。四层楼板长二十、厚零点三、深十五，位于高度十一点七五、纵轴零；南面幕墙长二十、高三、厚零点零八，位于高度十三点四、纵轴负七点五。平屋顶长二十、厚零点二、深十五，封于高度十五。金属栏杆三组：一组长十八、厚零点一、宽零点八，位于高度六点零五、纵轴负六点九；一组长十九、厚零点一、宽零点八，位于高度九点七五、纵轴负七点四；一组长零点八、厚零点一、深十三，位于横轴九点四、高度六点零五、纵轴零点五。全部零度朝向。`,
  },
  {
    name: 'house',
    input: `混凝土基底长十二、高一、深八，位于横轴零、高度零点五、纵轴零。混凝土主房间长七、高三、深八，设于横轴负二点五、高度二点五；木质上层房间长八、高三、深八，设于横轴负二、高度五点五、纵轴负零点五。东翼混凝土起居室长五、高三点五、深六，设于横轴三点五、高度二点七五、纵轴负一。东侧落地玻璃窗长四、高二点八、厚零点零八，位于横轴三点五、高度二点四、纵轴负四；普通玻璃窗厚零点零八、高一点五、宽一点五，位于横轴六、高度二点五、纵轴负一。二层南面玻璃幕墙长五、高二点五、厚零点零八，位于横轴负二、高度五点二五、纵轴负四点五；西面玻璃窗厚零点零八、高二、宽二，位于横轴负六、高度五点五；北面玻璃窗长三、高一点五、厚零点零八，位于横轴负二、高度五点七五、纵轴三点五。混凝土入口踏板长三、厚零点一五、宽一，位于横轴负零点五、高度一点零七五、纵轴负四点五。主屋顶为平顶，长八点五、厚零点二、深八点五，位于横轴负二、高度七点一、纵轴负零点二五；东翼屋顶长五点五、厚零点一五、深六点五，位于横轴三点二五、高度四点五八、纵轴负零点七五。有机树木一棵，尺寸长三、高五、深三，位于横轴负十、高度二点五、纵轴负一。石板小径长十六、厚零点零三、深十二，铺于地面。全部零度朝向。`,
  },
 {
    name: 'office_tower',
    input: `这座名为办公大楼的大型对称建筑共包含一百二十三个物件。大楼前方铺设了带有一排六棵阵列树木和前置入口雨棚的大型石材广场，主体结构建于巨型底板上，由二十根呈五乘四网格分布的二十三点八米高主柱支撑；其六个楼层的内部空间逐层向外微幅延展，每层均被三点三米高的四面玻璃幕墙完全封闭，内部固定包含中央封闭式核心筒、十字形横穿隔墙以及对称分布在四角的四张木制办公桌，最顶层设有平顶及独立的设备机房。`,
  },
 {
    name: 'resort',
    input: `广阔的石材地面承载着五十单位宽的玻璃水域。主楼为三层退台混凝土结构，各层高度间距三点五，宽度从十八逐层缩减。每层标配阳台、金属护栏与玻璃幕墙。十二根混凝土长柱支撑整体框架。东西两侧对称分布着两座木质别墅，均配有木质露台与玻璃墙面。中心南侧设有玻璃泳池，泳池由四根立柱支撑混凝土顶盖。场景中散落着十三棵具有精确非整数尺寸（如二点二六、一点六七等描述的比例）的有机树木，坐标点位通过精确的数值逻辑锁定。泳池边等距排列着四组织物沙发。所有旋转参数均设定为零。`,
  },
];


// ====== 单测 ======
async function testSingle(name: string, input: string): Promise<PipelineResult | null> {
  console.log(`\n==== Testing ${name} ====`);
  const startedAt = Date.now();

  try {
    // Stage 1 用旗舰模型(更强的结构化能力)，Stage 2 也用旗舰
    // 用 user prompt 中的标记位区分阶段
    const result = await run(input, async (system, user) => {
      const isStage2 = user.includes('CURRENT SENTENCE');
      const model = isStage2 ? 'qwen-max-latest' : 'qwen-max-latest';
      return callQwen(system, user, model);
    });

    const fileName = `output_${name}.html`;
    writeFileSync(fileName, result.html);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `  ✓ Saved ${fileName}  ` +
      `entities=${result.entityCount}  ` +
      `sentences=${result.normalized.length}  ` +
      `finalDOF=${result.finalDOF}  ` +
      `time=${elapsed}s`,
    );
    return result;
  } catch (e) {
    if (e instanceof Error) {
      console.error(`  ✗ Failed: ${e.message}`);
      if (e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
    } else {
      console.error(`  ✗ Failed: ${String(e)}`);
    }
    return null;
  }
}

// ====== 主流程 ======
async function main() {
  console.log('Debug: API Key exists?', !!process.env.DASHSCOPE_API_KEY);
  if (!process.env.DASHSCOPE_API_KEY) {
    console.error('DASHSCOPE_API_KEY missing — set it in .env');
    process.exit(1);
  }

  const summary: { name: string; entities: number; ok: boolean }[] = [];
  for (const tc of testCases) {
    const r = await testSingle(tc.name, tc.input);
    summary.push({
      name: tc.name,
      entities: r?.entityCount ?? 0,
      ok: !!r && r.entityCount > 0,
    });
  }

  console.log('\n==== SUMMARY ====');
  for (const s of summary) {
    console.log(`  ${s.ok ? '✓' : '✗'}  ${s.name.padEnd(14)} entities=${s.entities}`);
  }
  console.log('\nAll tests done.');
}

main();
