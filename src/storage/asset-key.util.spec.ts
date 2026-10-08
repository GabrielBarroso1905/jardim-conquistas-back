import { normalizeWorldSvgKey } from './asset-key.util';

describe('normalizeWorldSvgKey', () => {
  it('mantém keys no formato assets/...', () => {
    expect(normalizeWorldSvgKey('assets/words/lago/bg.svg')).toBe(
      'assets/words/lago/bg.svg',
    );
  });

  it('converte ponteiro supabase:// para assets/words/...', () => {
    expect(
      normalizeWorldSvgKey(
        'supabase://jardim-das-conquistas/words/lago/bg.svg',
      ),
    ).toBe('assets/words/lago/bg.svg');
  });

  it('prefixa words/ com assets/', () => {
    expect(normalizeWorldSvgKey('words/leticia/bg.svg')).toBe(
      'assets/words/leticia/bg.svg',
    );
  });

  it('não altera caminho local', () => {
    expect(
      normalizeWorldSvgKey('src/assets/worlds/ancoras/mundo2.svg'),
    ).toBe('src/assets/worlds/ancoras/mundo2.svg');
  });
});
