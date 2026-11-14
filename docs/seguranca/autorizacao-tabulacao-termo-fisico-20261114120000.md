# Pacote — tabulação de termo físico restrita à gestão (20261114120000)

Status: **PENDENTE DE APROVAÇÃO EXPRESSA PARA APLICAÇÃO.** Não autoriza, por si só, nenhuma execução em produção. Não há linha em `docs/seguranca/migracoes-aprovadas.tsv`.

## Escopo (mudança mínima)

- Duas linhas em `public.tabulacoes` (catálogo existente), `somente_gestao = true`, ativas, retorno `NENHUM`, próxima ação `CONTATAR`, `efeito_desfecho` nulo:
  - `TERMO_FISICO_EM_ANDAMENTO` — "Possui termo físico assinado, em andamento"
  - `TERMO_FISICO_ARQUIVADO` — "Termo físico arquivado, quitado"
- Trigger `aluno_mov_tabulacao_so_gestao` (`BEFORE INSERT OR UPDATE OF status_novo` em `aluno_movimentacoes`), função `aluno_movimentacao_tabulacao_so_gestao()` (SECURITY DEFINER, `search_path = public`). Recusa **apenas** os dois códigos acima para quem não é gestão (42501, "restrita à gestão"). Normalização por `[A-Z0-9_]`, para cobrir espaços e caracteres invisíveis.
- Gestão: os três e-mails de `usuario_e_gestao()` (Amanda gestora, Fernanda, Amanda ADM). Nenhuma permissão nova.
- Bypass: `service_role` (claim) e chamada sem `SET ROLE` do PostgREST (sessão do dono, migrações, RPCs de sistema).

**Não cria tabela nem RPC.** Não altera `alunos`, baixa, contato, fidelização, retorno, fila ou efeito financeiro. Outros códigos `somente_gestao` (ex.: `RETORNO_FINANCEIRO`) **não são tocados** por esta mudança, para não afetar o desfazer do operador.

## Artefatos

| PR | Branch | Head |
|---|---|---|
| #954 (banco) | `feat/termo-fisico-registro-migracao` | `0d706c00` (ver PR para o head atual) |
| #951 (front) | `feat/tabulacao-termo-fisico` | `9c4d870b` |

| Arquivo | SHA-256 | Bytes |
|---|---|---|
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente` | `74137cb54eee7c2300e8d8939de9d10168df98187acf1cce1f4321223b281d2e` | 3387 |
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.rollback.sql` | `a17b400205a740fb72c8729b87df8a97d337a057c2516eefbd388bcc60b4bc7c` | 670 |
| `scripts/seguranca/auditoria_seguranca.sql` (Gate A, corrigido) | `002d706ea04fc69012a3adaa0a2eb09685257406ca14d7240af2a0b00d97557f` | 5347 |

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
- **Triagem Prime, efeito a jusante:** a descrição fixa não casa com as palavras-chave, mas não medi o efeito em produção.

## Reversão

Rollback (`.rollback.sql`, em `BEGIN/COMMIT`): remove a trigger e a função; **desativa** (não apaga) as duas linhas do catálogo (`ativa = false`, `desativada_em`, `desativada_por = 'rollback_termo_fisico'`). O histórico gravado permanece. Não há tabela nem RPC a reverter.

## Ordem de implantação (explícita)

1. Aprovação final e linha em `migracoes-aprovadas.tsv` (RUNBOOK §6, com expiração e executor nominal). Não feito aqui.
2. Aplicar a migration (executor único, sessão principal, autorização nominal).
3. Validação somente leitura: as duas linhas do catálogo com `somente_gestao = true`; a trigger existe; sem linhas novas no histórico fora da gestão.
4. Gate A (linha de base antes e depois), com autorização de leitura.
5. **Só então** merge da #951 (frontend).
