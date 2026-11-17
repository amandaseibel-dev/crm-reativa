# Autorização v2 — tabulação de termo físico (20261114120000) — PENDENTE DE APROVAÇÃO

**Status: PENDENTE DE APROVAÇÃO. Nenhuma aprovação foi registrada. Não autoriza execução de migration, rollback, SQL em produção, merge ou publicação de M1.**

## Relação com a autorização anterior

- A autorização anterior, `docs/seguranca/autorizacao-tabulacao-termo-fisico-20261114120000.md`, **não foi reescrita**. Ela está no conteúdo do head `1ac94a6f`, em que ainda constava o SHA-256 `d4f41e313a08f64cc6b746072f13d9a65bc8a62e3ea976248277165f1409bdc4` (5000 bytes) para o rollback.
- Esta v2 **substituiria** a anterior somente se for aprovada. Até lá, a anterior segue como registro histórico.
- Divergências que esta v2 registra (sem reescrever a anterior):
  - o rollback declarado na anterior (`d4f41e31…`, 5000 bytes, commit `be990338`) não é o rollback presente no head;
  - o rollback atual (`96871b2e…`, 6215 bytes, commit `c0d217d1`) é mais restritivo;
  - a anterior listava os artefatos de teste de contenção sem SHA-256;
  - a menção à contenção `20261114140000` na anterior foi resolvida pela separação (ver abaixo).
- **Referência "Resultado":** a autorização anterior (registro `1ac94a6f`) diz "ver seção 'Resultado'", e o título da seção de resultados nela é "Resultados por SHA". A referência deve ser lida como essa seção. A anterior não foi corrigida; esta v2 registra os resultados por head na seção "Resultados por head".
- **Correções e atualizações registradas nesta v2 (a anterior não é reescrita):**
  - Hash da auditoria: a anterior cita `scripts/seguranca/auditoria_seguranca.sql` com SHA-256 `87ed9b7326c6fdbdffd2956c1d3b3f448910ae2e0010f11954418de9c986dd85` (5682 bytes). O arquivo atual, idêntico ao `origin/main` e não alterado por esta #954, tem `d2a4c33179e9b0a05f63b33469bcbdd3a35c5e108dc587845bce9ac8f7ab0c67` (5629 bytes). A correção é de registro; o pacote não altera o arquivo.
  - Texto de cobertura do CI: a anterior fala em "recusas" sem detalhar. Esta v2 lista as oito recusas do `recusas_rollback.sh` (aluno, catálogo, contenção ativa, contenção alterada por outro autor, histórico com variante e aluno com variante).
  - Preparações de teste da contenção (`11p_*`, `12p_on`, `12p_off`): usam atualização direta da flag, com o mesmo efeito sobre `contencao_ativa`, e não a migration B1 nem a sua pré-condição/transação.
  - Evidências novas que a anterior não listava: `recusas_rollback.sh`, `fingerprint_dados_termo.sql`, `snapshot_termo_fisico.sql`, `12n_contencao_flag_fixture.sql`.

## Escopo final

- **Entrega:** migration `20261114120000` (tabulação de termo físico restrita à gestão, barreira de histórico, RPC de registro e tabela de contenção, cuja flag começa `false`).
- **Fora do escopo, separada e não aplicada:** migration `20261114140000` (ativação da contenção, B1). Preservada no branch local `proposta/contencao-termo-20261114140000` (commit `427300d7`, arquivos em `supabase/aguardando_aprovacao/20261114140000_*` e `supabase/tests/tabulacao_termo_fisico_gestao/12p_reaplica.sql`). Não é dependência da entrega (ver seção de dependência).
- **Fora do escopo:** trava `20261106140000` (branch `wip/trava-so-gestao-20261106140000`), e `20261114130000` (retirada do recorte, inexistente no repositório).

## Artefatos (SHA-256 completo e tamanho em bytes, no head desta proposta)

| Arquivo | SHA-256 | Bytes | Situação |
|---|---|---|---|
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente` | `fb24afa4138710d7010ec3db73d2e21f1dffa8e0c36963a39469b446aafce713` | 11118 | **alterado em relação ao autorizado** (`1c81eb71…`, 10313): R1 (comentário) e pré-condições de dependências de produção (`tabulacoes`, `usuario_e_gestao()`, `app_usuario_ativo()`) |
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.rollback.sql` | `30315b81d0b9346741daf100927e3d4ed49ebceafa053a6169c12f03e62cf0fe` | 6724 | **diferente do autorizado** (`d4f41e31…`, 5000); versão com normalização de variantes (B3) |
| `supabase/tests/tabulacao_termo_fisico_gestao/recusas_rollback.sh` | `de4e3e00a9e3fb6016714a1a592685eb2e497e29cb37103dd77516f0ecd48c49` | 4579 | evidência (novo; oito cenários) |
| `supabase/tests/tabulacao_termo_fisico_gestao/fingerprint_dados_termo.sql` | `be702c3b4e653a52ea4910a6854b15ef4bc3c74c51a0ee9c436ed57ef3759476` | 1690 | evidência (novo; normalizado) |
| `supabase/tests/tabulacao_termo_fisico_gestao/snapshot_termo_fisico.sql` | `7181ce340942ee18c2035c54af6d2b242139a25a0fe34b30024ea8d1ce6f129b` | 1973 | evidência |
| `supabase/tests/tabulacao_termo_fisico_gestao/12n_contencao_flag_fixture.sql` | `848891fb90c68888be72e08e15e308cc7683a2c21daf3a6b6d096a6ad363aff8` | 1719 | evidência (novo) |

Hashes calculados com `shasum -a 256` no head final. Qualquer alteração posterior invalida esta tabela.

## Rollback: autorizado × proposto

| | Autorizado (anterior) | Proposto (esta v2) |
|---|---|---|
| Commit | `be990338` | versão final desta v2 (com normalização). Versão anterior sem normalização: `c0d217d1` (`96871b2e…`, 6215 bytes), substituída por esta correção. |
| SHA-256 | `d4f41e313a08f64cc6b746072f13d9a65bc8a62e3ea976248277165f1409bdc4` | `30315b81d0b9346741daf100927e3d4ed49ebceafa053a6169c12f03e62cf0fe` |
| Bytes | 5000 | 6724 |

### Diferenças funcionais

1. **Catálogo (comportamento, mais restritivo):** a versão autorizada conferia código, `criado_por`, `criado_em` e datas. A proposta confere o conteúdo exato gravado pela migração (rótulo, ordem, `ativa`, `somente_gestao`, grupo, retorno, bloco, flags, e-mail de redirecionamento, `atualizado_por` e `desativada_por`). **Motivo:** sem isso, o rollback apagaria uma linha de catálogo editada pela gestão sem recusa. **Efeito:** mais recusas; nenhuma remoção de dado editado.
2. **Mensagem da recusa de contenção (texto):** "contenção foi alterada por outro autor (alterado_por diferente da migração)". A verificação é a mesma.
3. **Comentários do cabeçalho (texto):** explicam a detecção de alteração da contenção por `alterado_por`, e que o snapshot do CI cobre ACL e RLS.
4. **Normalização de variantes (comportamento, B3):** a trigger normaliza o código (ASCII antes do upper, `COLLATE "C"`), e a gestão pode gravar `' termo_fisico_arquivado '` ou `'TERMO_FISICO_arquivado'`. A versão anterior comparava de forma exata e aceitava o rollback com esses registros. **Motivo:** o rollback removeria a barreira com registros de código não canônico. **Correção:** a mesma normalização da trigger no histórico (`tipo` e `status_novo`) e no estado do aluno (`status_atual`, `status_jornada`, `status_acionamento`), e na impressão de dados do teste. **Efeito:** mais recusas; nenhum valor armazenado é alterado nem limpo. Reproduzido em banco descartável antes da correção (rollback aceito) e depois (recusado com o motivo específico).

**Sem diferença:** ordem (todas as recusas antes de qualquer `DROP`), `begin`/`commit`, GRANT/REVOKE/POLICY (nenhum), objetos removidos no caminho de sucesso.

### Efeito sobre dados, recusas, permissões e recuperação

- **Dados:** nenhuma recusa altera dados ou objetos. Comprovado por impressão antes e depois de cada tentativa (ver evidências).
- **Recusas:** histórico de termo; aluno no estado de termo; catálogo fora do conteúdo exato; contenção ativa; contenção alterada por outro autor.
- **Permissões:** nenhum GRANT, REVOKE ou POLICY no rollback.
- **Recuperação:** rollback recusado deixa tudo como está. Reversão exige decisão da gestão.

## Dependência da B1 (contenção `20261114140000`)

- A entrega **não depende** da B1 para funcionar com segurança: a `20261114120000` cria a flag com `contencao_ativa = false` (registros abertos) e o gatilho e a RPC leem a flag sem a B1.
- Se a B1 for aplicada e revertida, `alterado_por` fica `reversao_b1` e o rollback da `20261114120000` é **recusado** até decisão da gestão. Isso foi comprovado em bancada (PGlite, papel `postgres`, que não prova o gatilho; ver evidências). Portanto, a B1 **não pode ser aplicada junto** sem decisão específica.
- Os testes de contenção do CI ligam e desligam a flag por fixture (`fixture_teste` / `migration_termo_fisico`), não pela migração B1.

## Evidências a apresentar com esta proposta

1. **CI do head final, job `tabulação termo físico`** (rodado no GitHub Actions, PostgreSQL 17 do job, papéis `app_teste` LOGIN e `app_teste_inh` LOGIN com herança, criados pelo job). Inclui: registro autorizado pela gestão (`07_registro_administrativo.sql`); recusa a operador (`02_tabulacao.sql`, `09_login_nao_privilegiado.sql`, `10_login_inherit_defensivo.sql`); barreira de alunos com login não privilegiado (`05_barreira_alunos.sql`); PostgREST 16.5 real com JWT (operador recusado, gestão aceita, claims forjadas recusadas); rollback recusado por histórico (`03`); rollback limpo com igualdade de snapshot antes e depois (`Caminho B`, `04_rollback_limpo.sql`); recusas por aluno, catálogo, contenção ativa, contenção alterada, histórico com variante e aluno com variante (`recusas_rollback.sh`, oito cenários) com impressão idêntica antes e depois; flag NOT NULL e ligar/desligar por fixture idempotente (`12n_contencao_flag_fixture.sql`).
2. **Ambiente de teste (CI):** `dono_teste` é NOLOGIN com `bypassrls`, criado apenas para simular o dono das funções; nenhum papel de teste existe em produção.
3. **Produção:** dono das funções `postgres` (rolsuper=false, rolbypassrls=true, medido em leitura); clientes `anon`, `authenticated`, `service_role` do PostgREST. **Privilégios do pacote (corrigido, antes afirmava "nenhuma alteração"):** a migração faz `revoke` e `grant` apenas em objetos criados por ela: tabela `termo_fisico_contencao` (`revoke all`, sem grant a usuários), função da trigger (`revoke`, sem `execute` para ninguém) e RPC `registrar_administrativo_termo_fisico` (`revoke` de `public`, `anon` e `service_role`, `grant execute` apenas a `authenticated`, com gate interno por `app_usuario_ativo()` e `usuario_e_gestao()`). Nenhum grant ou revoke em tabela ou função existente. O rollback não tem GRANT, REVOKE nem POLICY.
4. **Bancada PGlite (não substitui o CI; não reconferida nesta v2):** executa como `postgres`, que o gatilho ignora. Usada só para validar a lógica das recusas e a sensibilidade da impressão digital (ela muda com cada ajuste e fica igual antes e depois de cada recusa).
5. **Guardião:** parecer sobre o head final, em texto, sem usar resultados de commits anteriores.

## Bloqueios que permanecem

### Herdados da v1 (`autorizacao-tabulacao-termo-fisico-20261114120000.md`, bloqueios 1–7), não resolvidos por esta v2
1. **Gate A:** 7 achados `BLOQUEIA` abertos, de outras frentes: `BUCKET_PUBLICO` `tv-imagens`, `TABELA_SEM_RLS` `_tmp_fila2`, 5 views com `VIEW_BYPASS_RLS`. Sem exceção nem declaração de resolução.
2. **Reconciliação:** `usuario_e_gestao()` só como evidência (sem migration versionada em `supabase/migrations`), mas chamada pela migration `20261114120000`. `_encerramento_so_gestao()` fora desta #954.
3. **Auth:** configuração de confirmação e troca de e-mail não lida (não verificada).
4. **Papel `reativa_responsavel_executor`** (INSERT irrestrito): não lido se é usado com `SET ROLE` por cliente.
5. **`tabulacoes` sem DDL base versionado.**
6. **CI verde no head final e parecer do Guardião sem `REPROVADO`:** pendente até a conclusão desta rodada.
7. **Autorização nominal, executor único e janela M1:** só na aprovação.

### Achados desta v2 (não estavam na v1)
- **Script de recusas sem `trap`:** `recusas_rollback.sh` sai com `exit 1` sem restaurar o fator alterado. Aceitável só em banco descartável.
- **`\\set` no rollback:** `20261114120000.rollback.sql` só roda via `psql`, não pelo SQL Editor.
- **Falha de restauração no teste 15:** se `12p_off` falhar sob `set -e`, `15p_dono_restore` é pulado. O comentário do CI não diz isso.

## Não aprovado

- Não há aprovação em nome de nenhuma pessoa. Esta proposta fica pendente até decisão explícita da gestão.
- Não autoriza aplicar `20261114140000` nem reverter `20261114120000`.

## Recorte e estado de validação

- **Esta v2 está no recorte `termo-fisico-recorte`** (branch nova a partir de `origin/main` `979de7b6`). A PR #954 (`feat/termo-fisico-registro-migracao`) permanece como referência, com o histórico preservado; seus heads `f725c5cb`, `f94d25c8` e `4dca987a` não são o pacote desta v2.
- **Escopo do recorte:** 49 arquivos do diff `origin/main...feat/termo-fisico-registro-migracao` (verificado), todos de termo físico. O número 321 que apareceu antes vinha de um `main` local desatualizado, não do diff da PR.
- **Validação:** CI e Guardião do head do recorte são registrados na PR de recorte, não nesta seção. Nenhum parecer anterior é considerado validação deste head.
- **Ressalvas de publicação (não de merge):** Gate A, Auth, `usuario_e_gestao()` sem migration versionada (catálogo em `docs/seguranca/evidencias/catalogo_usuario_e_gestao_20261116.md`), papel `reativa_responsavel_executor`, `tabulacoes` sem DDL versionado; higiene dos `.sql` de evidência com `CREATE OR REPLACE` (carregados por `\\i` no CI, não renomeados).
- **Nenhuma aprovação registrada.**

## O que o merge desta PR faz (e não faz)

- **Não aplica SQL.** O CI (`.github/workflows/ci.yml`) roda somente com `PGHOST: localhost`, sem `supabase link`, sem `supabase db push`, sem token de Supabase e sem segredo de acesso ao projeto. Lido em 61f9737d.
- **Não aplica a migration.** O arquivo `20261114120000_*.sql.pendente` fica em `supabase/aguardando_aprovacao/`. O Supabase CLI aplica apenas `supabase/migrations/`, que esta PR não altera.
- **Não ativa funcionalidade.** Nenhum arquivo de `src/`, `.jsx` ou `supabase/migrations/` é alterado. Nenhuma tela chama `registrar_administrativo_termo_fisico`.
- **Deploy de frontend.** `vercel.json` implanta `main`, mas esta PR não altera frontend, então não há mudança de comportamento. `netlify.toml` publica só `tv-v11`, sem relação.
- **Limite não verificável no repositório:** se houver integração Supabase-GitHub configurada no painel do projeto que aplique migrations no merge, ela não aparece no repositório. A ação necessária é confirmar no painel do projeto de produção, antes do merge, que nenhuma integração aplica `aguardando_aprovacao/` ou faz deploy automático de banco. Não confirmei isso.

## Limites dos testes (CI)

- `usuario_e_gestao()`, `app_usuario_ativo()` e `tabulacoes` são **simulados** no CI (stubs em `01_ambiente.sql`). Os testes provam a lógica desta entrega com esses stubs. **Não provam** a lista de identificadores, o corpo, os grants, o dono nem a ACL reais de produção.
- Os identificadores de teste foram substituídos por valores de `@exemplo.local` nos testes, para não repetir identificadores institucionais. O stub não reproduz a lista real de produção.
- Papéis `app_teste`, `app_teste_inh` e `dono_teste` existem só no banco descartável do CI.
- PGlite roda como `postgres`, que o gatilho ignora; não serve de prova de autorização.

## Bloqueios de implantação (abertos; não são de merge)

1. **Gate A:** 7 achados `BLOQUEIA` abertos (ver seção de bloqueios herdados). Ação: a gestão declara resolução ou exceção formal antes da publicação.
2. **Auth:** confirmação de e-mail e troca de e-mail não verificadas. A força da gestão depende de `auth.jwt()->>email`. Ação: verificar a configuração de Auth no painel do projeto; não alterar sem autorização.
3. **`usuario_e_gestao()`:** sem migration versionada. Ação: decisão da gestão sobre a lista e o versionamento (ver `docs/seguranca/evidencias/catalogo_usuario_e_gestao_20261116.md`).
4. **`tabulacoes`:** sem DDL versionado. Ação: confirmar as colunas e restrições reais de produção (leitura) antes da implantação.
5. **`app_usuario_ativo()`:** corpo e ACL não conferidos. Ação: leitura de catálogo de produção.
6. **Papel `reativa_responsavel_executor`:** INSERT irrestrito. Ação: verificar se algum cliente assume o papel.
7. **Evidências SQL com `CREATE OR REPLACE`** (`docs/seguranca/evidencias/prod_encerramento_so_gestao.sql` e `prod_usuario_e_gestao.sql`): não executar em produção. O CI carrega o primeiro com `\\i`.
8. **Identificadores institucionais:** a cópia exata de `prod_usuario_e_gestao.sql` foi retirada da entrega e está em acesso restrito; a referência com SHA-256 está em `docs/seguranca/evidencias/REFERENCIA_prod_usuario_e_gestao.md`. Ação: a gestão define o destino de equipe.
