# ReATIVA One — registro de versões

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
