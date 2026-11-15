# Pacote — tabulação de termo físico restrita à gestão (20261114120000)

Status: **PENDENTE DE APROVAÇÃO EXPRESSA PARA APLICAÇÃO.** Não autoriza, por si só, nenhuma execução em produção. Não há linha em `docs/seguranca/migracoes-aprovadas.tsv`.

## Escopo (mudança mínima)

- Duas linhas em `public.tabulacoes` (catálogo existente), `somente_gestao = true`, ativas, retorno `NENHUM`, próxima ação `CONTATAR`, `efeito_desfecho` nulo:
  - `TERMO_FISICO_EM_ANDAMENTO` — "Possui termo físico assinado, em andamento"
  - `TERMO_FISICO_ARQUIVADO` — "Termo físico arquivado, quitado"
- Trigger `aluno_mov_tabulacao_so_gestao` (`BEFORE INSERT OR UPDATE OF status_novo` em `aluno_movimentacoes`); normalização em ASCII (`[^A-Za-z0-9_]`) **antes** do `upper()`, para não depender do locale, função `aluno_movimentacao_tabulacao_so_gestao()` (SECURITY DEFINER, `search_path = public`). Recusa **apenas** os dois códigos acima para quem não é gestão (42501, "restrita à gestão"). Normalização por `[A-Z0-9_]`, para cobrir espaços e caracteres invisíveis.
- Gestão: os três e-mails de `usuario_e_gestao()` (Amanda gestora, Fernanda, Amanda ADM). Nenhuma permissão nova.
- Bypass: `service_role` (claim) e chamada sem `SET ROLE` do PostgREST (sessão do dono, migrações, RPCs de sistema).

**Não cria tabela nem RPC.** Não altera `alunos`, baixa, contato, fidelização, retorno, fila ou efeito financeiro. Outros códigos `somente_gestao` (ex.: `RETORNO_FINANCEIRO`) **não são tocados** por esta mudança, para não afetar o desfazer do operador.

## Artefatos

| PR | Branch | Head |
|---|---|---|
| #954 (banco) | `feat/termo-fisico-registro-migracao` | `f88a24b9` (head com estes artefatos; o commit de docs que registra este head é posterior) |
| #951 (front) | `feat/tabulacao-termo-fisico` | `9c4d870b` |

| Arquivo | SHA-256 | Bytes |
|---|---|---|
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente` | `ccc028ea65110d2cbdbfb48bfee184d35b8f32fc61b4071b325ce90ccc5def82` | 4909 |
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.rollback.sql` | `03114cfdc1f282ebf44cd20a51b1031b29aceabdb39b08bf5e1f490436d234ef` | 3650 |
| `scripts/seguranca/auditoria_seguranca.sql` (Gate A, corrigido) | `87ed9b7326c6fdbdffd2956c1d3b3f448910ae2e0010f11954418de9c986dd85` | 5682 |

Se algum arquivo mudar, este quadro precisa ser refeito.

## Definições lidas em produção (só SELECT, nesta sessão)

- `usuario_e_gestao()`: `lower(coalesce(auth.jwt()->>'email','')) in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br')`; `SECURITY DEFINER`; `search_path = public`.
- `eh_tipo_acionamento(text)`: lista de 12 tipos. `REGISTRO_ADMINISTRATIVO` não está nela.
- `_encerramento_so_gestao()` (trigger em `alunos`): lê `somente_gestao` do catálogo dinamicamente (`from public.tabulacoes where somente_gestao`), além do piso fixo. Não é o array fixo das versões antigas do repositório.
- `trg_tabulacao_efeito_financeiro`: só age com `efeito_desfecho` preenchido.
- `fn_atualizar_ultimo_acionamento`: só age quando `eh_tipo_acionamento(tipo)`.
- `trg_zz_desfazer_cartao_tabulacao`: só age em `tipo = 'FINALIZACAO_ATENDIMENTO'`.
- `trg_tabulacao_redireciona`: só age em UPDATE de `alunos`.
- `notificacoes`, `app_usuario_ativo()` e privilégios padrão de `public`: conferidos na sessão de auditoria anterior.

## Reconciliação com produção (evidências versionadas)

| Objeto | Arquivo | md5 do corpo (produção = arquivo) | chars |
|---|---|---|---|
| `usuario_e_gestao()` | `docs/seguranca/evidencias/prod_usuario_e_gestao.sql` | `af3d391f4234e6a352585777897568e4` | 321 bytes |
| `_encerramento_so_gestao()` | `docs/seguranca/evidencias/prod_encerramento_so_gestao.sql` | `5ff3be8222f1f33d6a679be8b313fec5` | 5346 |

O md5 foi calculado no próprio banco (`md5(pg_get_functiondef(...))`, só leitura) e comparado com o md5 do arquivo. Iguais. Sem aplicação retroativa: os arquivos são evidência, não migração.

**Divergência declarada, reconciliada por evidência:** a versão de `_encerramento_so_gestao()` no repositório (`supabase/migrations/20261007143000_...`) é um array fixo; a de produção lê o catálogo. A versão dinâmica está em `supabase/aguardando_aprovacao/20261106140000_tabulacao_so_gestao_no_banco.sql.pendente`, sem entrada no ledger. **A reconciliação completa do repositório (versionar a função de produção) fica como pré-requisito de aplicação.**

## Barreira de estado em alunos (testada, no CI)

`supabase/tests/tabulacao_termo_fisico_gestao/00_barreira_producao.sql` carrega a função de produção e a trigger real `trg_encerramento_so_gestao`. `05_barreira_alunos.sql` roda com um papel de LOGIN (`app_teste`), porque a função deixa passar `session_user = postgres`. Confirma: operador não grava código restrito no estado do aluno (42501); código comum passa. **Não executado localmente** (pglite tem um único usuário); a prova é o job de CI.

## Estado do aluno (alunos.status_*): barreira de produção (divergência declarada)

DIVERGÊNCIA: a função `_encerramento_so_gestao()` **em produção** lê o catálogo (lida nesta sessão). A versão **versionada no repositório** (`supabase/migrations/20261007143000_antecipacao_semestre_quita_responsabilidade.sql`) usa array fixo (`CANCELAMENTO_COBRANCA`, `SUSPENSAO_COBRANCA`, `JURIDICO`, `ANTECIPACAO_SEMESTRE`, `ALEGA_*`), sem os códigos de termo. A versão dinâmica está em `supabase/aguardando_aprovacao/20261106140000_tabulacao_so_gestao_no_banco.sql.pendente` e não tem entrada no ledger. Logo, a barreira depende de estado de produção que o repositório não reproduz. **Não testada** nos testes desta migração (os testes não criam `alunos` nem a trigger). Decisão: reconciliar o repositório com produção antes da aplicação, ou aceitar explicitamente.

A trigger `trg_encerramento_so_gestao` está **ativa** em `public.alunos` (`BEFORE UPDATE OF status_atual, status_jornada, status_acionamento`, `tgenabled = O`). A função `_encerramento_so_gestao()` lida em produção nesta sessão lê o catálogo dinamicamente (`from public.tabulacoes where somente_gestao`). Logo, as duas linhas novas com `somente_gestao = true` passam a barrar também a gravação do **estado** do aluno por operador, não só o histórico. Sem essas linhas, o operador poderia gravar o estado antes do histórico. Este é o caminho que a auditoria pediu para provar (leitura de produção).

## Desfazer do operador (limitação declarada)

`desfazer_acao` grava `ACAO_DESFEITA` com o status restaurado. Se o status restaurado for um dos dois códigos restritos, a trigger recusa para o operador e o desfazer aborta. Só ocorre se a gestão tiver gravado um código restrito e o operador desfizer outra ação. **Decisão pendente:** aceitar e documentar, ou tratar (ver ressalvas).

## Pré-condições (guardas na migração)

- Aborta se já existir linha com os dois códigos e flags divergentes do esperado (não segue em silêncio).
- Aborta se a trigger `aluno_mov_tabulacao_so_gestao` já existir.

## Testes (CI e simulação local)

- `supabase/tests/tabulacao_termo_fisico_gestao/`: gestão permitida (três e-mails); operador recusado (código exato, com espaço e minúsculas, TAB/LF/CR, Unicode invisível, `FINALIZACAO_ATENDIMENTO` com código restrito); UPDATE do operador em `status_novo` recusado pela trigger; sem perfil, diretoria e anon recusados; escopo (`RETORNO_FINANCEIRO` não é barrado); ausência de efeitos; triagem Prime (descrição fixa não casa com as palavras-chave); não acionamento; rollback.
- Simulação: dependências simuladas em `01_ambiente.sql`. Não é o Supabase real.

## NÃO verificado

- **Staging:** inacessível nesta conta.
- **Produção, depois da aplicação:** RLS e grants reais de `aluno_movimentacoes` (a policy de UPDATE real não foi lida), e a validação somente leitura.
- **PostgREST real** (o `SET ROLE` é simulado).
- **Locale do Postgres de produção**, para os caracteres Unicode (a normalização não depende de locale).
- **Gate A em produção:** a linha de base não foi executada (precisa de autorização). O `ORDER BY` foi corrigido e validado em pglite.
- **Owner ou superuser** pode desabilitar a trigger; não coberto.
- **`usuario_e_gestao()`** não tem definição versionada no repositório. O corpo usado aqui é o lido em produção nesta sessão (três e-mails); a definição deve ser versionada antes da aplicação.
- **Simulação de `anon`:** o ambiente de teste dá privilégios padrão a `anon`, como produção (default ACL lida). A proteção de `anon` nesta migração vem da RLS (`app_usuario_ativo()`), não de ausência de grant; o teste confirma o efeito, não o grant.
- **Rollback** desativa o catálogo mas não repõe `somente_gestao` (a flag continua true nas linhas desativadas; a trigger de alunos lê a flag independentemente de `ativa`).
- **Outros triggers BEFORE** em `aluno_movimentacoes` executados depois desta trigger (ordem alfabética): não listados em produção.
- **Upper/locale do banco:** normalização em ASCII antes do upper; testado em pglite, não no locale de produção.
- **Triagem Prime, efeito a jusante:** a descrição fixa não casa com as palavras-chave, mas não medi o efeito em produção.

## Gate A: 7 achados `BLOQUEIA` pré-existentes (encaminhamento de outra frente)

- `BUCKET_PUBLICO` `tv-imagens`: exceção limitada da TV após revisão do conteúdo público. **Não feito nesta frente.**
- `TABELA_SEM_RLS` `_tmp_fila2`: revogação de acesso sem apagar a tabela. **Não feito nesta frente.**
- `VIEW_BYPASS_RLS` (5 views): correção com testes dos consumidores. **Não feito nesta frente.**

Esta frente não duplica essas mudanças. **O Gate A não é declarado aprovado** enquanto esses 7 achados não forem tratados e o gate for reexecutado com resultado zero `BLOQUEIA`.

## Decisões aplicadas nesta rodada

- **Desfazer do operador:** se o status restaurado for código restrito, o desfazer é recusado **inteiro** (a trigger recusa `ACAO_DESFEITA`; a transação da `desfazer_acao` é desfeita junto, sem alteração parcial), com a mensagem "Não é possível desfazer esta ação ... Nada foi desfeito. A gestão trata pelo fluxo autorizado."
- **Rollback exato:** antes da migração as linhas não existiam; o rollback as remove. Só o faz se (1) as linhas estiverem exatamente como a migração as deixou (qualquer campo alterado, inclusive `somente_gestao` e rótulo, recusa inteira) e (2) nenhum registro de histórico usar os códigos (o histórico é preservado; se houver, recusa inteira). Só então remove as linhas, a trigger e a função, em `BEGIN/COMMIT`.

## Leituras de produção feitas nesta rodada (só SELECT, sem gravar)

- Catálogo: nenhuma linha `TERMO_FISICO_%`; trigger `aluno_mov_tabulacao_so_gestao` e função ausentes (as guardas da migração passam).
- Perfis: Amanda (`gerencia`), Fernanda (`supervisor`) e Amanda ADM (`administrativo`), todos ativos. Os dois `diretoria` (Gustavo e Angela) ficam fora da gestão.
- **Gate A em produção (linha de base, só SELECT):** achados `BLOQUEIA` pré-existentes, **não causados por esta mudança**: `BUCKET_PUBLICO` = `tv-imagens` (1); `TABELA_SEM_RLS` = `_tmp_fila2` (1); `VIEW_BYPASS_RLS` = `vw_extracao_calibragem`, `vw_extracao_observabilidade`, `vw_extracao_validacao_trilha`, `vw_pagamento_suspeita_pendente`, `vw_titulo_presenca_historico` (5). O CHECKLIST diz que qualquer `BLOQUEIA` reprova o gate. **Decisão da gestão necessária:** tratar esses achados antes do deploy, ou registrar aceite explícito. Esta migração não os resolve.
- Achados `ALERTA` pré-existentes (não bloqueiam): políticas amplas, RLS sem policy com grant, `RPC_SECDEF_EXECUTE_ANON` (24), tabelas de backup sem RLS.

## Dependências de aplicação (todas precisam estar cumpridas)

1. Gate A sem `BLOQUEIA` (7 achados acima, tratados pela frente responsável e reexecutados).
2. Reconciliação do repositório com produção para `_encerramento_so_gestao()` (versionar o corpo real; hoje há divergência).
3. Versionamento de `usuario_e_gestao()` no repositório (o corpo está em evidência, sem migração).
4. CI verde do head da migração, com os jobs `tabulacao-termo-fisico-gestao-sql` e `trava tabulacao somente gestao` (confirmação pelo conector ou `gh`; nesta sessão o acesso ao GitHub não estava autenticado).
5. Auditoria do Guardião sem `REPROVADO` sobre o head final.
6. Autorização nominal, linha em `migracoes-aprovadas.tsv`, executor único.

## Reversão

Rollback (`.rollback.sql`, em `BEGIN/COMMIT`): remove a trigger e a função; **desativa** (não apaga) as duas linhas do catálogo (`ativa = false`, `desativada_em`, `desativada_por = 'rollback_termo_fisico'`). O histórico gravado permanece. Não há tabela nem RPC a reverter.

## Ordem de implantação (explícita)

0. Decisão da gestão sobre os achados `BLOQUEIA` pré-existentes do Gate A (acima).
1. Aprovação final e linha em `migracoes-aprovadas.tsv` (RUNBOOK §6, com expiração e executor nominal). Não feito aqui.
2. Aplicar a migration (executor único, sessão principal, autorização nominal).
3. Validação somente leitura: as duas linhas do catálogo com `somente_gestao = true`; a trigger existe; sem linhas novas no histórico fora da gestão.
4. Gate A (linha de base antes e depois), com autorização de leitura.
5. **Só então** merge da #951 (frontend).
