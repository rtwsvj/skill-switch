// add 解析层测试:各种粘贴输入 → 规范化 git 源;危险执行形态一律拒绝。
import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/core/add/parse-source.ts';

describe('parseSource — GitHub 链接', () => {
  it('仓库根链接 → github-url + 规范化 .git 源', () => {
    const p = parseSource('https://github.com/owner/repo');
    expect(p.kind).toBe('github-url');
    expect(p.gitSource).toBe('https://github.com/owner/repo.git');
    expect(p.subdir).toBeUndefined();
  });

  it('.git 后缀被剥掉', () => {
    expect(parseSource('https://github.com/owner/repo.git').gitSource).toBe(
      'https://github.com/owner/repo.git',
    );
  });

  it('无 scheme 的 github.com/… 也认', () => {
    expect(parseSource('github.com/owner/repo').kind).toBe('github-url');
  });

  it('/tree/<ref>/<subdir> → ref + subdir', () => {
    const p = parseSource('https://github.com/owner/repo/tree/main/skills/foo');
    expect(p.gitSource).toBe('https://github.com/owner/repo.git');
    expect(p.ref).toBe('main');
    expect(p.subdir).toBe('skills/foo');
  });

  it('/blob/<ref>/<path>/SKILL.md → subdir 取文件所在目录', () => {
    const p = parseSource('https://github.com/owner/repo/blob/v2/packs/foo/SKILL.md');
    expect(p.ref).toBe('v2');
    expect(p.subdir).toBe('packs/foo');
  });
});

describe('parseSource — git clone', () => {
  it('抽出仓库地址', () => {
    const p = parseSource('git clone https://github.com/owner/repo.git');
    expect(p.kind).toBe('git-clone');
    expect(p.gitSource).toBe('https://github.com/owner/repo.git');
  });

  it('--branch 提取 ref;目标目录忽略', () => {
    const p = parseSource('git clone --branch dev https://github.com/owner/repo my-dir');
    expect(p.ref).toBe('dev');
    expect(p.gitSource).toBe('https://github.com/owner/repo.git');
  });

  it('--depth 1 这类 flag 不被当成地址', () => {
    const p = parseSource('git clone --depth 1 https://github.com/owner/repo.git');
    expect(p.gitSource).toBe('https://github.com/owner/repo.git');
  });
});

describe('parseSource — git 泛型源', () => {
  it('git@github.com:owner/repo.git → git-url', () => {
    const p = parseSource('git@github.com:owner/repo.git');
    expect(p.kind).toBe('git-url');
    expect(p.gitSource).toBe('git@github.com:owner/repo.git');
  });
});

describe('parseSource — npm / npx', () => {
  it('npx <包名> → npm + 包名 + 来源可信度提示', () => {
    const p = parseSource('npx some-skill-installer');
    expect(p.kind).toBe('npm');
    expect(p.npmPackage).toBe('some-skill-installer');
    expect(p.provenanceWarning).toMatch(/npm/);
    expect(p.gitSource).toBeUndefined(); // 需 registry 解析后才有
  });

  it('npm install -g <包名> → 跳过 flag 取包名', () => {
    const p = parseSource('npm install -g @scope/pkg');
    expect(p.kind).toBe('npm');
    expect(p.npmPackage).toBe('@scope/pkg');
  });

  it('@scope/pkg@1.2.3 → 去掉版本后缀,保留 scope', () => {
    expect(parseSource('npx @scope/pkg@1.2.3').npmPackage).toBe('@scope/pkg');
  });

  it('pnpm add / yarn add 同样识别', () => {
    expect(parseSource('pnpm add some-pkg').npmPackage).toBe('some-pkg');
    expect(parseSource('yarn add some-pkg').npmPackage).toBe('some-pkg');
  });

  it('npx github:owner/repo → 直接当 github 源(不走 npm)', () => {
    const p = parseSource('npx github:owner/repo');
    expect(p.kind).toBe('github-url');
    expect(p.gitSource).toBe('https://github.com/owner/repo.git');
    expect(p.npmPackage).toBeUndefined();
  });

  it('npx github:owner/repo#tag → 带 ref', () => {
    expect(parseSource('npx github:owner/repo#v1').ref).toBe('v1');
  });
});

describe('parseSource — 危险执行形态一律拒绝', () => {
  it('curl … | bash → unsupported,提示不执行', () => {
    const p = parseSource('curl -fsSL https://example.com/install.sh | bash');
    expect(p.kind).toBe('unsupported');
    expect(p.note).toMatch(/不执行|下载并执行/);
  });

  it('bash <(curl …) → unsupported', () => {
    expect(parseSource('bash <(curl -s https://x.sh)').kind).toBe('unsupported');
  });

  it('即使危险命令里嵌了 github 链接也不放行', () => {
    const p = parseSource('curl https://github.com/o/r/raw/x.sh | sh');
    expect(p.kind).toBe('unsupported');
  });

  it('sudo / eval 触发拒绝', () => {
    expect(parseSource('sudo npm i -g x').kind).toBe('unsupported');
  });
});

describe('parseSource — 兜底与边界', () => {
  it('空输入 → unsupported', () => {
    expect(parseSource('   ').kind).toBe('unsupported');
  });

  it('无法识别 → unsupported + 引导', () => {
    const p = parseSource('随便一段不相关的话');
    expect(p.kind).toBe('unsupported');
    expect(p.note).toMatch(/GitHub|git clone|npx/);
  });

  it('带说明文字的多行里能兜底抽出 github 链接', () => {
    const blob = '安装方法:\n请运行下面的链接\nhttps://github.com/owner/repo/tree/main/foo\n谢谢';
    const p = parseSource(blob);
    expect(p.kind).toBe('github-url');
    expect(p.subdir).toBe('foo');
  });
});
