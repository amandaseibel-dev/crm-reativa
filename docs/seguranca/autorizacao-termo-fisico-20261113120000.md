# Pacote — registro administrativo do termo físico (20261113120000)

Status: **PENDENTE DE APROVAÇÃO EXPRESSA PARA APLICAÇÃO.** Este documento registra o pacote. Não autoriza, por si só, nenhuma execução em produção. Não há linha em `docs/seguranca/migracoes-aprovadas.tsv`.

## Escopo

Cria a tabela `public.aluno_termo_fisico_eventos` (append-only), RLS de leitura para `usuario_e_gestao()`, as RPCs `termo_fisico_ler` e `termo_fisico_registrar`, as triggers de bloqueio e avisos em `notificacoes` para os três e-mails de `usuario_e_gestao()`. Não altera alunos, movimentações, casos, fila, fidelização, retorno, acordos, parcelas, títulos, catálogo `tabulacoes` nem efeito financeiro. "Arquivado" não comprova quitação nem gera baixa.

## Artefatos

| PR | Branch | Commit (HEAD) |
|---|---|---|
| #954 (banco) | `feat/termo-fisico-registro-migracao` | `735df2f56ef9b5b9116e5a09d9290c1d55ed8a41` |
| #951 (front) | `feat/tabulacao-termo-fisico` | `ef5520ec4c7be253df08adcec86ad0974a5019ba` |

| Arquivo | SHA-256 | Bytes |
|---|---|---|
| `supabase/aguardando_aprovacao/20261113120000_aluno_termo_fisico_registro.sql.pendente` | `5e9b2f417a98b6c3435940adcc2df5be7e92741a90aa28f7e67b3c0eda12a827` | 8425 |
| `supabase/aguardando_aprovacao/20261113120000_aluno_termo_fisico_registro.rollback.sql` | `8c0ac2be1b7526f227f17b945c6afe02a2065aa4c83263da87bcbac76eb300fb` | 2221 |

Se algum arquivo mudar, este quadro precisa ser refeito.

## Pré-condições conferidas por leitura em produção (só SELECT)

- `usuario_e_gestao()`: `pg_get_functiondef`. Corpo: `lower(coalesce(auth.jwt()->>'email','')) in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br')`. `SECURITY DEFINER`, `search_path = public`.
- `usuario_e_gestao_fila()`: inclui `usuario_e_gestao()` **ou** perfis `gerencia`, `supervisor`, `administrativo` (corpo lido).
- `notificacoes`, policies lidas: `notificacoes_select` = `usuario_e_gestao_fila() OR destinatário = e-mail do JWT`. `notificacoes_insert` = `app_usuario_ativo() AND usuario_e_gestao()`. `notif_select_proprias` e `notif_update_proprias` (destinatário). Triggers: só `trg_notificacoes_diretoria_nao_recebe`. Sem `CHECK` em `tipo`.
- Destinatários (usuários ativos): Amanda = `gerencia`, Fernanda (`cobranca04`) = `supervisor`, Amanda ADM (`cobranca07`) = `administrativo`. Não há nenhum dos três com `diretoria`, então o trigger de diretoria não descarta aviso. Há 2 usuários `diretoria` ativos, fora da lista.
- `app_usuario_ativo()`: `exists (... lower(u.email) = lower(coalesce(auth.jwt()->>'email','')) and u.ativo is true)`.
- Privilégios padrão de `public` (`pg_default_acl`): tabelas dão `arwdDxtm` a `anon`, `authenticated`, `service_role`; funções dão `EXECUTE` a `anon`, `authenticated`, `service_role`. O simulado do CI reproduz isso.
- `alunos.id`: `uuid`. A RPC recebe `text` e compara por `id::text`.
- Nomes livres: 0 objetos `aluno_termo_fisico%` e 0 funções `termo_fisico%` em `public`.

## Decisão do aviso (opção A, registrada)

O aviso vai para os **três** destinatários, incluindo quem registrou. Não há anonimato do autor. O conteúdo é genérico ("Registro administrativo atualizado"), sem aluno, situação nem autor. Quem lê `notificacoes` (perfis `gerencia`, `supervisor`, `administrativo`) vê que um aviso existe, e a gestão aceitou isso.

## Prova antes de aplicar (não aplicado)

- Job `termo-fisico-acesso-sql` no CI (Postgres 17 isolado, dependências **simuladas**, ver `supabase/tests/termo_fisico_acesso/README.md`): migration, acesso por papel, rollback, reinstalação. Negativas por SQLSTATE (`42501`, `22023`, `42883`). PUBLIC pela ACL. Privilégios de tabela incluindo REFERENCES, TRIGGER, MAINTAIN (PG 17+).
- Testes do front: `RegistroTermoFisico.test.js` e `RegistroTermoFisico.comportamento.test.jsx` (42501 some; falha técnica avisa; gravação não afirma que nada foi gravado).

## NÃO verificado

- **Staging:** inacessível nesta conta. Nenhum teste contra o Supabase real.
- **Gate A (`auditoria_seguranca.sql`):** o script não existe neste checkout. Não executado.
- **Grants e RLS reais após aplicação:** só serão lidos depois da aplicação autorizada.
- **Owner ou superuser** pode desabilitar triggers; isso não é coberto.
- **Ausência de usuário inativo e de authenticated sem perfil** nos testes simulados.

## Reversão

Rollback (`.rollback.sql`): remove as duas RPCs; **renomeia** a tabela para `aluno_termo_fisico_eventos_descartada_20261113` e o índice para `aluno_termo_fisico_eventos_descartada_20261113_aluno_idx`; mantém as triggers; retira todo acesso dos papéis da aplicação, inclusive PUBLIC. Não apaga dados.

Reinstalação: documentada no próprio rollback. Reaplica a migration (tabela e índice novos, vazios), copia com `on conflict (id) do nothing`, confere a contagem. A tabela arquivada continua sem acesso. Nunca renomear a arquivada de volta com a tabela nova populada.

## Ordem de implantação (explícita)

1. Aprovar a linha em `docs/seguranca/migracoes-aprovadas.tsv` (fluxo do RUNBOOK §6, com expiração e executor nominal). Não feito aqui.
2. Aplicar a migration da #954 (executor único, sessão principal) com autorização nominal.
3. Validar **somente leitura** após a aplicação: objetos existem, grants e ACL conferem, triggers e policies presentes. Sem registrar nem notificar ninguém.
4. **Só então** fazer merge da #951. Mesclar o front antes da migration deixa a gestão vendo o aviso "indisponível" (comportamento desenhado, mas indesejado).
