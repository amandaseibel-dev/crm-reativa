# Alcance real do bloqueio operacional — versão 20260928124933

Registro de acompanhamento da versão `20260928124933`
(`bloqueio_operacional_temporario_caso_7891`), aplicada em produção em
28/09/2026 12:49:33 UTC. Este arquivo **não roda**: documenta o que foi medido e
o que apenas consta no código.

A mudança é de **um campo em uma linha**: `casos.nao_acionar` de `false` para
`true`, mais o motivo em `casos.observacao_operacional`, no caso **7891**
(ficha `bd46ef71-be72-47e1-9658-e50ff086197a`).

Motivo autorizado pela gestão: *conferência de titularidade dos títulos
vinculados e solicitação da composição documental do acordo 63361*.

## Por que isso é maior do que "ações massivas e D-2"

`nao_acionar` não é um campo de uma tela só. Na data do registro, **31 funções
em `public` leem esse campo**. Isso amplia o alcance do bloqueio muito além das
duas portas que motivaram o pedido — e é justamente por isso que ele é
temporário e reversível.

## Efeitos VERIFICADOS (medidos nesta aplicação)

| O quê | Como foi verificado |
|---|---|
| `nao_acionar` passou de `false` para `true` e persistiu | leitura após a transação |
| Valor anterior preservado | `_backup_bloqueio_operacional_caso_7891_20260928`, 1 linha, `nao_acionar = false`, observação vazia |
| A ficha tem exatamente **um** caso | guarda dentro da transação + leitura |
| **Nenhum alerta D-2 foi encerrado** | `acordo_alertas_parcela` para essa ficha: **zero** linhas, abertas ou históricas |
| Saldos intactos | caso e ficha seguem em R$ 7.402,87 (vencido R$ 3.515,31) |
| Acordo 63361 intacto | ATIVO, R$ 5.831,32, 6 parcelas, 6 parcelas vivas |
| Títulos e vínculos intactos | 7 títulos seguem na ficha, vínculos inalterados |
| Status, tabulação, operador e `encerrado_operacional` intactos | asseridos dentro da transação e relidos depois |
| `trg_repor_caso_operador` **não** agiu | duas razões independentes, ambas medidas: `carteira.geral@reativa.local` não é `perfil='operador'` ativo em `usuarios`; e `caso_protegido_redistribuicao` já era `true` ANTES (acordo ATIVO no CPF), então a condição "não protegido → protegido" nunca ocorreu |

O gatilho `casos_set_encerrado_operacional` preserva o valor quando
`cpf_limpo` e os quatro `status_*` não mudam — foi o caso aqui.

## Efeitos IDENTIFICADOS NO CÓDIGO (não exercitados)

Nada abaixo foi observado acontecendo nesta sessão. É leitura de código.

- **Ações Massivas** — o executor exclui aluno com qualquer caso
  `nao_acionar` (`20260807220124_hardening_acoes_massivas_executor.sql`,
  linha 78).
- **Alerta D-2** — `aluno_bloqueado_para_d2` passa a retornar `true`
  (`20260921180147_d2_bloqueio_operacional.sql`): `acordo_alertas_gerar` não
  cria novo alerta, e `acordo_alertas_resolver` fecharia um alerta aberto com
  resolução `BLOQUEADO`. Como não há alerta nenhum, o efeito aqui é apenas
  preventivo — a próxima parcela vence em 06/10, cujo D-2 cairia em 04/10.
- **Filas e custódia** — `assumir_caso_livre`, `assumir_caso_livre_aluno`,
  `fila_fora_da_cobranca`, `casos_elegiveis_liberacao_fidelizacao`,
  `casos_reabrir_com_divida`, `confirmar_saldo_zero_retirar_filas`,
  `girar_mensalidades_com_acordo`.
- **Distribuição, teto e nivelamento** — `caso_protegido_redistribuicao`,
  `redistribuir_casos_operadores`, `redistribuir_casos_operadores_faixas`,
  `preview_redistribuicao_casos`, `reforcar_teto_operadores`,
  `reposicao_carteira_processar`, `nivelamento_automatico_gestao`,
  `alterar_responsavel_aluno`, `casos_risco_perder`, `trg_impor_teto_operador`,
  `trg_repor_caso_operador`, e a família `calibragem_*`.
- **Indicador** — `_penetracao_ano_montar`.

## Limitação conhecida

**O acionamento manual continua possível.** `nao_acionar` não é consultado em
nenhum ponto do front-end (`src/`): um operador que abrir a ficha não é
impedido de registrar contato. O bloqueio cobre os caminhos automáticos e em
lote, no banco. Fechar essa porta depende de orientação da gestão aos
operadores. O caso estava com `data_retorno` em 28/09 e **esse retorno não foi
alterado**.

## Como desfazer

`supabase/rollbacks/20260928124933_bloqueio_operacional_temporario_caso_7891.rollback.sql`.

Ele **aborta** se o campo tiver mudado depois do bloqueio, em vez de
sobrescrever a decisão de outra pessoa.

Observação: o texto gravado em `casos.observacao_operacional` aponta para
`supabase/rollbacks/bloqueio_operacional_temporario_caso_7891.rollback.sql`,
**sem** o prefixo de versão. O arquivo real segue a convenção do projeto (mesmo
timestamp da migration). O conteúdo gravado em produção não foi alterado só
para acertar esse caminho — seria uma segunda escrita na ficha sem necessidade.

## O que este bloqueio NÃO decide

A titularidade do acordo 63361 — que nasceu da importação com o CPF da própria
ficha — e a inconsistência dos títulos vinculados a ele são **fatos separados**.
Nenhum dos dois foi alterado, e nenhum dos dois é resolvido por este registro.
