# Pacote — tabulação de termo físico restrita à gestão (20261114120000)

Status: **PENDENTE DE APROVAÇÃO EXPRESSA PARA APLICAÇÃO.** Este pacote não autoriza execução em produção. Não há linha em `migracoes-aprovadas.tsv` (a linha M1 está preparada em rascunho, sem validade; ver seção própria).

## Escopo

- **Migração (aplicar):** duas linhas em `public.tabulacoes` com `somente_gestao = true` (retorno `NENHUM`, próxima ação `CONTATAR`, `efeito_desfecho` nulo, rótulos aprovados) e a trigger `aluno_mov_tabulacao_so_gestao` (BEFORE INSERT OR UPDATE OF status_novo em `aluno_movimentacoes`) com a função `aluno_movimentacao_tabulacao_so_gestao()` (SECURITY DEFINER, `search_path = public`). A trigger recusa **só** os dois códigos para quem não é gestão (42501, "restrita à gestão"). Normalização: `upper(regexp_replace(status, '[^A-Za-z0-9_]', '', 'g') COLLATE "C")`.
- **Gestão:** os três e-mails de `usuario_e_gestao()` (Amanda gestora, Fernanda, Amanda ADM). Nenhuma permissão nova.
- **Bypass:** `service_role` (claim) e chamada sem `SET ROLE` do PostgREST (sessão do dono). Ver dependências sobre o papel `reativa_responsavel_executor`.
- **Registro:** grava só em `aluno_movimentacoes`, com tipo `REGISTRO_ADMINISTRATIVO`, que não está em `eh_tipo_acionamento()`. Não altera `alunos`, baixa, contato, fidelização, retorno, fila ou efeito financeiro.
- **Não cria** tabela nem RPC.
- **Desfazer do operador:** se o status restaurado for um dos dois códigos, o desfazer é **recusado inteiro** (mensagem "Nada foi desfeito"). Decisão aplicada e testada no CI.

## Rollback (reversão) — decisão: opção A

**O rollback NÃO remove nada e recusa sempre**, com mensagem clara ("rollback recusado por decisão registrada"). Motivo: as duas linhas do catálogo são lidas pela barreira de estado em `alunos` (`_encerramento_so_gestao`, em produção). Removê-las reabriria a gravação de `TERMO_*` no estado do aluno pelo operador. Por isso a reversão é **correção para frente**, com decisão e migração próprias.

- Testes: CI, caminho B (banco limpo) confirma que o rollback recusa e que as linhas, a trigger de histórico e a barreira de estado permanecem.
- Coordenação com o frontend: a barreira no banco impede gravação dos códigos restritos independentemente do front. A remoção da opção na tela (#951) é decisão separada.
- O item "rollback preparado" do §13 fica **preparado como recusa segura**, não como reversão completa.


## Artefatos

| PR | Branch | Head |
|---|---|---|
| #954 (banco) | `feat/termo-fisico-registro-migracao` | `703acc26` (head com estes artefatos; o commit deste documento é posterior ou igual) |
| #951 (front) | `feat/tabulacao-termo-fisico` | `9c4d870b` |

| Arquivo | SHA-256 | Bytes |
|---|---|---|
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente` | `e8a495412d770ca6bd230d13bfa5e8a5a0a92c3bb6a71650176048d0f4693b25` | 5042 |
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.rollback.sql` | `43dce0cfd3c7f0d84ad49920721629693f04dcf19245dd69b571648b65793375` | 4029 |
| `scripts/seguranca/auditoria_seguranca.sql` (Gate A, corrigido) | `87ed9b7326c6fdbdffd2956c1d3b3f448910ae2e0010f11954418de9c986dd85` | 5682 |

## Evidências de produção (somente leitura, versionadas)

| Objeto | Arquivo | md5 (produção = arquivo) |
|---|---|---|
| `usuario_e_gestao()` | `docs/seguranca/evidencias/prod_usuario_e_gestao.sql` | `af3d391f4234e6a352585777897568e4` (321 bytes) |
| `_encerramento_so_gestao()` | `docs/seguranca/evidencias/prod_encerramento_so_gestao.sql` | `5ff3be8222f1f33d6a679be8b313fec5` (5346 caracteres) |
| schema, RLS, grants, policies e triggers de `aluno_movimentacoes` e `tabulacoes` | `docs/seguranca/evidencias/prod_schema_rls_grants_movimentacoes_tabulacoes.md` | transcrição do resultado do SQL (sem md5 — ver limites) |

Os md5 de `usuario_e_gestao()` e `_encerramento_so_gestao()` foram calculados no banco (`md5(pg_get_functiondef(...))`) e comparados com o arquivo: iguais. Os arquivos são evidência, não migração; não há aplicação retroativa.

**Divergência declarada:** `_encerramento_so_gestao()` no repositório (`supabase/migrations/20261007143000_...`) é um array fixo; em produção lê o catálogo. A versão dinâmica está em `supabase/aguardando_aprovacao/20261106140000_tabulacao_so_gestao_no_banco.sql.pendente`, sem ledger. **Pré-requisito:** versionar o corpo real antes da aplicação (hoje a evidência está em `docs/`, não em migração).

## Barreira de estado em `alunos` (testada no CI)

`00_barreira_producao.sql` carrega a função real e a trigger `trg_encerramento_so_gestao`. `05_barreira_alunos.sql` roda como papel de LOGIN (`app_teste`), porque a função deixa passar `session_user = postgres`. Testada no job de CI; não executada localmente (pglite tem um usuário).

## Gate A: 7 achados `BLOQUEIA` (não resolvidos)

- `BUCKET_PUBLICO` `tv-imagens`: exceção limitada da TV após revisão do conteúdo público.
- `TABELA_SEM_RLS` `_tmp_fila2`: revogação de acesso, sem apagar a tabela.
- `VIEW_BYPASS_RLS` (5 views): correção com testes dos consumidores.

**Linha de base executada em produção (só leitura)** — resultado: os 7 achados acima. Esta frente **não** resolveu nenhum deles e **não** os tratou como exceção genérica. O gate **não** é declarado aprovado. A reexecução depende da frente responsável, que não está nesta sessão.

## Dependências de aplicação (todas precisam estar cumpridas)

1. Gate A sem `BLOQUEIA`, com os 7 achados tratados pela frente responsável e reexecutado.
2. Versionar `_encerramento_so_gestao()` (corpo real) e `usuario_e_gestao()` no repositório, e remover a divergência com o `.pendente` de 20261106140000.
3. Papel `reativa_responsavel_executor` (INSERT irrestrito em `aluno_movimentacoes` pela policy `aluno_movimentacoes_insert_executor`): confirmar por leitura que ele não é usado com `SET ROLE` por cliente. Não lido nesta sessão.
4. `tabulacoes` sem DDL base versionado em `supabase/` (só fixture): versionar a definição real ou confirmar a fixture com as colunas de produção.
5. Confirmação de e-mail obrigatória no Auth (`usuario_e_gestao()` confia no claim `email`): não lida.
6. Outros triggers BEFORE em `aluno_movimentacoes` e sua ordem: não listados além dos três acima.
7. CI verde no head da migração e na #951 (jobs `tabulacao-termo-fisico-gestao-sql` e `trava tabulacao somente gestao`), conferido pelo `gh`.
8. Auditoria do Guardião sem `REPROVADO` sobre o head final.
9. Autorização nominal, linha M1 (rascunho em `docs/seguranca/linha-m1-rascunho-20261114120000.md`) publicada **no momento da aprovação**, executor único.

## Limites declarados

- Staging inacessível nesta conta.
- PostgREST real (o `SET ROLE` é simulado) e locale de produção (a normalização usa `COLLATE "C"`, mas o locale real não foi conferido).
- Owner ou superuser pode desabilitar triggers.
- A simulação de `aluno_movimentacoes` usa `id uuid`; produção tem `id bigint`. Os testes não inserem `id`.
- Schema, RLS e grants de produção estão transcritos em `docs/seguranca/evidencias/prod_schema_rls_grants_movimentacoes_tabulacoes.md`, sem fingerprint.

## Ordem de implantação (explícita)

1. Resolver as dependências 1 a 8 (a dependência de rollback foi substituída pela opção A) (Gate A pela frente responsável; reconciliação de versionamento; CI; Guardião).
2. **Aprovação final** e publicação da linha M1 no momento da aprovação, com executor nominal e validade de 30 minutos a partir dela.
3. Aplicar a migração (executor único, sessão principal).
4. Validação somente leitura: duas linhas com `somente_gestao = true`; trigger ativa; nenhuma linha nova no histórico fora da gestão.
5. Gate A de linha de base, depois da aplicação, com autorização de leitura.
6. **Só então** merge do #951 (frontend). Antes da migração, a barreira no banco já existe, mas a opção ainda aparece para a gestão sem o catálogo.

## Reversão (resumo)

Rollback recusa sempre (opção A). Reversão é correção para frente, com decisão e migração próprias.
