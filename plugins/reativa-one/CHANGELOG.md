# ReATIVA One — registro de versões

## Não lançado — 2026-10-16 (correção dos nomes de conector na CLI)

Sem mudança de versão. Teste L1 executado: ver `tests/L1-roteiro.md`.

- **Camada 0** (`.claude/settings.json`, dois commits separados): as regras do
  Supabase e do Vercel citavam só o id em UUID do app desktop. Na linha de
  comando o conector do claude.ai se chama `claude_ai_Supabase` /
  `claude_ai_Vercel`, e a regra por nome exato não casava. Cada regra UUID
  ganhou o par `claude_ai_*` (Supabase: 11 `deny` e `execute_sql` em `ask`;
  Vercel: 17 `deny`). Nenhuma regra removida, nenhuma permissão ampliada.
- **Autoteste:** 72 casos (eram 63). C01–C07 repetem B39–B47 com o prefixo da
  CLI; S01–S02 leem o `settings.json` e falham se um conector ficar com só um
  dos dois nomes.
- **Limitação conhecida, não resolvida:** `execute_sql` continua em `ask` e a
  exigência de aprovação nunca foi demonstrada. A Camada 0 **não é declarada
  plenamente segura** enquanto isso valer.
- **Achados do L1 não tratados aqui (decisão pendente):** o conector Supabase na
  CLI expõe `create_edge_function_secret`, que não está negado; e o Vercel
  `create_project` também não está.

## 1.0.0 — 2026-10-16 (Fase 1)

Primeira versão. Entrega **Guardião** e **Desenvolvedor**; as outras quatro
especializações são Fase 2 e não existem neste pacote.

- **Camada 0** (`.claude/settings.json`, versionado): `deny` para o que
  reescreve produção, publica, mescla ou expõe segredo; `ask` para execução
  arbitrária com escrita ou acesso externo. As 397 entradas de `allow` de
  `.claude/settings.local.json` **não foram alteradas** — `deny` e `ask` vencem
  `allow`, então não foi preciso mexer no arquivo pessoal e não versionado.
- **Camada 1** (`hooks/guardiao.sh`): 20 regras cobrindo Bash, Edit/Write,
  MCP por sufixo, terminal do app, navegador e sessão na nuvem. Indeterminado
  nega. Nenhuma proibição absoluta depende só desta camada.
- Agentes `guardiao` (sem Edit/Write) e `desenvolvedor` (escopo obrigatório,
  parada quando a correção exige regra no banco).
- Skills `fontes-de-verdade` e `seguranca-rls`: ponteiros para `docs/`, zero
  regra duplicada.
- 6 comandos; 3 scripts; autoteste com 63 casos.
- **Sem token de autorização nesta fase**: migration, merge e deploy ficam em
  negação pura.
- Não altera `ci.yml`, `package.json`, `src/`, `supabase/`, `docs/` nem
  `scripts/`. A única linha fora de `plugins/` e `.claude/` é uma entrada de
  `.gitignore` para o arquivo de estado por projeto.
