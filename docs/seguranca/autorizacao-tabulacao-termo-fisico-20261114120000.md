# Pacote — tabulação de termo físico restrita à gestão (20261114120000)

**Status: PREPARAÇÃO CONCLUÍDA. IMPLANTAÇÃO BLOQUEADA** pelos achados reais do Gate A (ver seção própria). Não autoriza execução em produção. Não há linha em `docs/seguranca/migracoes-aprovadas.tsv`. A linha M1 está em rascunho sem validade (`docs/seguranca/linha-m1-rascunho-20261114120000.md`).

## Escopo efetivo (o que o código faz)

**Migração (`supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente`):**
- Duas linhas em `public.tabulacoes` (`somente_gestao = true`, `ativa`, retorno `NENHUM`, próxima ação `CONTATAR`, `efeito_desfecho` nulo, `criado_em` fixo em 2026-11-14 00:00 -03, `criado_por = 'migration_termo_fisico'`), com os rótulos aprovados: "Possui termo físico assinado, em andamento" e "Termo físico arquivado, quitado".
- Trigger `aluno_mov_tabulacao_so_gestao`, **BEFORE INSERT OR UPDATE** em `aluno_movimentacoes`, função `aluno_movimentacao_tabulacao_so_gestao()` (SECURITY DEFINER, `search_path = public`, sem GRANT, EXECUTE revogado de public/anon/authenticated/service_role).
- Normalização de código e tipo: `upper(regexp_replace(valor, '[^A-Za-z0-9_]', '', 'g') COLLATE "C")`.
- **Imposição de `REGISTRO_ADMINISTRATIVO` no banco:** só gestão (`usuario_e_gestao()`: Amanda gestora, Fernanda, Amanda ADM); só com um dos dois códigos; sem `status_anterior`, `data_retorno`, `valor_movimentacao`, `baixa_pagamento_id`, `solicitacao_link_id`, `link_pagamento` e `motivo_devolucao`. Qualquer violação é recusada (42501).
- **Burla:** mudança de tipo ou código em UPDATE, espaços/tab/Unicode, `FINALIZACAO_ATENDIMENTO` com código restrito e `ACAO_DESFEITA` com código restrito são recusados; o desfazer é recusado inteiro com a mensagem "Nada foi desfeito".
- **Bypass:** `service_role` (claim) e chamada sem `SET ROLE` do PostgREST (sessão do dono). Ver dependências (papel `reativa_responsavel_executor`).
- **Efeitos:** o tipo `REGISTRO_ADMINISTRATIVO` não está em `eh_tipo_acionamento()`. Os três triggers de `aluno_movimentacoes` lidos em produção (`trg_atualizar_ultimo_acionamento`, `trg_sincronizar_elogio_da_movimentacao`, `trg_zz_desfazer_cartao_tabulacao`) não reagem a ele. O registro não escreve em `alunos`, casos, baixa, fila, saldo ou retorno.
- Não cria tabela nem RPC.

**Barreira de estado em `alunos` (produção, não alterada):** `trg_encerramento_so_gestao` com `_encerramento_so_gestao()`, que lê `somente_gestao` do catálogo. As duas linhas novas passam a barrar, para o operador, a gravação dos códigos restritos também no estado do aluno.

**Rollback (`supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.rollback.sql`):** **recusa sempre**, com `SQLSTATE P0001` e a mensagem "rollback recusado por decisão registrada: …". Não remove linha, trigger, função nem dado. Motivo: as linhas do catálogo são lidas pela barreira de estado em `alunos`; removê-las reabriria a gravação de `TERMO_*` pelo operador. **Reversão = correção para frente**, com decisão e migração próprias.

**Frontend (#951):** o registro é apenas **solicitado** (gravação em `aluno_movimentacoes`, sem escrita em `alunos`). A autorização e a ausência de efeitos são impostas pelo banco, não pela tela. O seletor só mostra os códigos para a gestão; essa escolha de tela não é barreira.

## Artefatos (SHA-256 integral)

| Arquivo | SHA-256 | Bytes |
|---|---|---|
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente` | `214ec3264cbf8bc0d973f7c04bc986c689999e81ae578adfe2a922bb0b2f027f` | 5792 |
| `supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.rollback.sql` | `e224e6f206471775eb4f45126d11d68393434d6e32b1a867aa61ba1b1f46cfaa` | 776 |
| `scripts/seguranca/auditoria_seguranca.sql` (Gate A corrigido) | `87ed9b7326c6fdbdffd2956c1d3b3f448910ae2e0010f11954418de9c986dd85` | 5682 |
| `docs/seguranca/evidencias/prod_usuario_e_gestao.sql` | `83191ea84a90cc0e098d8d33da6179a9c7b6ab4a73c23b2113d4007fbabdb288` | 321 |
| `docs/seguranca/evidencias/prod_encerramento_so_gestao.sql` | `cae8f5422b93341fb62debd5e524d10182054ffca7a968cf5b749928ecd3aea9` | 5366 |
| `docs/seguranca/evidencias/prod_schema_rls_grants_movimentacoes_tabulacoes.md` | `cc16b9d3fe38b58b86d842a17835faf131e0c383dc98f174a532f1deca2f4491` | 3944 |

Heads: #954 = `fb7a305aba4e488ba0c4c445780e49886992e241` (este commit). #951 = `9c4d870b340af3c64c6ed4a17026a0c3facccb66`.

## Evidências de produção (somente leitura)

- `usuario_e_gestao()`: `md5(pg_get_functiondef)` em produção = `af3d391f4234e6a352585777897568e4` = md5 do arquivo `docs/seguranca/evidencias/prod_usuario_e_gestao.sql`.
- `_encerramento_so_gestao()`: `md5` em produção = `5ff3be8222f1f33d6a679be8b313fec5` = md5 do arquivo `docs/seguranca/evidencias/prod_encerramento_so_gestao.sql` (5346 caracteres).
- Schema, RLS, grants, policies e triggers de `aluno_movimentacoes` e `tabulacoes`: `docs/seguranca/evidencias/prod_schema_rls_grants_movimentacoes_tabulacoes.md` (transcrição; sem fingerprint).

Divergência de repositório, declarada: `_encerramento_so_gestao()` versionada (`supabase/migrations/20261007143000_...`) é lista fixa; a de produção lê o catálogo. A versão dinâmica está em `supabase/aguardando_aprovacao/20261106140000_tabulacao_so_gestao_no_banco.sql.pendente`, sem ledger. **Pré-requisito de aplicação.**

## Testes (CI, job `tabulacao-termo-fisico-gestao-sql`)

Caminho A (com histórico) e B (banco limpo, sem histórico):
- `01_ambiente.sql` (simulação: papéis, `usuario_e_gestao()` com o corpo lido, `alunos`, `tabulacoes`, `aluno_movimentacoes` com as colunas de produção, `eh_tipo_acionamento()`).
- `02_tabulacao.sql`: gestão permitida, operador recusado (variantes), desfazer recusado, anon/sem perfil/diretoria recusados, triagem, não acionamento.
- `00_barreira_producao.sql`: carrega a função real de produção e a trigger de `alunos`.
- `05_barreira_alunos.sql`: papel de LOGIN `app_teste` (fora da lista de bypass): recusa do código restrito no estado do aluno; código comum permitido.
- `07_registro_administrativo.sql`: legítimos (gestão, dois códigos), negados (operador, sem perfil, diretoria, código comum, sem código, campos operacionais), burla (tipo, código, espaço/Unicode, UPDATE), ausência de efeito no aluno.
- Rollback: caminho A e B recusam com SQLSTATE `P0001` e mensagem exatos (`03_rollback_recusado.sql`, `04_rollback_limpo.sql`).
- `06_preservacao_rollback.sql`: catálogo exatamente como gravado, trigger de histórico, função, barreira de `alunos` e outras tabulações intactas.

Limites: a simulação não é o Supabase real (PostgREST, grants reais, outros triggers, locale de produção). O harness local foi reconstruído fora da worktree; o CI é a execução oficial.

## Resultados por SHA

- `fb7a305aba4e488ba0c4c445780e49886992e241`: ver seção "Resultado do CI" abaixo (preenchida depois da execução).

## Gate A: 7 achados `BLOQUEIA` (encaminhamento da frente responsável)

- `BUCKET_PUBLICO` `tv-imagens`: exceção limitada da TV após revisão do conteúdo público.
- `TABELA_SEM_RLS` `_tmp_fila2`: revogação de acesso, sem apagar a tabela.
- `VIEW_BYPASS_RLS`: `vw_extracao_calibragem`, `vw_extracao_observabilidade`, `vw_extracao_validacao_trilha`, `vw_pagamento_suspeita_pendente`, `vw_titulo_presenca_historico`: correção com testes dos consumidores.

**Estado: ABERTOS.** Nenhum foi tratado nesta frente. Não são exceções genéricas, e os testes do fixture não os resolvem. **Bloqueio de implantação**, com referência à frente responsável. A linha de base de produção (só leitura) já foi executada e registra os 7 achados.

## Dependências de aplicação (todas precisam estar cumpridas)

1. **Gate A sem `BLOQUEIA`** (os 7 achados acima, tratados pela frente responsável e reexecutados). **Aberto.**
2. Versionar `_encerramento_so_gestao()` (corpo real) e `usuario_e_gestao()` no repositório, removendo a divergência com o `.pendente` de 20261106140000. **Aberto.**
3. Papel `reativa_responsavel_executor` (INSERT irrestrito pela policy `aluno_movimentacoes_insert_executor`): confirmar por leitura que não é usado com `SET ROLE` por cliente. **Aberto.**
4. `tabulacoes` sem DDL base versionado em `supabase/` (só fixture): versionar a definição real. **Aberto.**
5. Confirmação de e-mail obrigatória no Auth (`usuario_e_gestao()` confia no claim `email`). **Aberto.**
6. Outros triggers BEFORE em `aluno_movimentacoes` e sua ordem (ver evidência). **Aberto.**
7. CI verde no head final (jobs `tabulacao-termo-fisico-gestao-sql` e `trava tabulacao somente gestao`), conferido pelo `gh`.
8. Auditoria do Guardião sem `REPROVADO` sobre o head final.
9. Autorização nominal, linha M1 publicada **somente no momento da aprovação**, com executor único e validade de 30 minutos.

## Decisões registradas (não reabertas)

- Rollback recusa sempre (opção A), sem remover objetos ou dados.
- Desfazer do operador com código restrito: recusado inteiro, com mensagem "Nada foi desfeito".
- Gestão: os três e-mails de `usuario_e_gestao()`, sem permissões novas.
- Descrição fixa do registro, sem observação livre.
- Rótulos aprovados preservados.

## Ordem de implantação

1. **Banco:** dependências 1 a 9 cumpridas; aprovação final; linha M1 publicada no momento da aprovação; aplicar a migração (executor único).
2. **Validação (somente leitura):** duas linhas com `somente_gestao = true`, trigger e função instaladas, barreira de `alunos` ativa, nenhuma linha nova de registro fora da gestão.
3. **Frontend (#951):** merge somente depois da validação do banco. Antes da migração, o banco não impõe a regra.

## Comunicado

Pronto para uso **somente após** publicação e validação. Não é enviado automaticamente. (Rascunho: `docs/seguranca/comunicado-tabulacao-termo-fisico-rascunho.md`, a ser criado após a aplicação.)

## Limites declarados

- Staging inacessível nesta conta.
- PostgREST real e locale de produção: não verificados.
- Owner ou superuser pode desabilitar triggers.
- Simulação de `aluno_movimentacoes`: `id bigint` como em produção.
