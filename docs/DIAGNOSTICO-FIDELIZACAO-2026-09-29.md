# Fidelizacao de 10 dias — levantamento dos caminhos automaticos (29/09/2026)

Leitura de producao (`ahattpqrjmhkzsmnbdzs`), somente SELECT. **Nenhuma escrita foi
feita em producao.**

REGRA: acionamento valido grava `casos.data_ultimo_acionamento`; desse dia ate
completar 10 dias o caso fica com o responsavel atual; nenhuma rotina automatica
de calibragem, nivelamento, teto ou redistribuicao o retira nesse periodo; no 11o
dia, sem novo acionamento, volta a ser elegivel; acionamento novo reinicia a
janela. Fonte unica: `public.caso_dentro_prazo_fidelizacao(date)` =
`dua is not null and dua + 10 >= current_date`.

## 1. Levantamento: quem escreve `casos.operador_email`

34 funcoes em producao escrevem `casos.operador_email`. Classificacao:

### a) Automaticas que retiram caso de operador — JA respeitavam os 10 dias (8)

`calibragem_executar_simulacao`, `calibragem_executar_nivelamento`,
`calibragem_executar_nivelamento_lote_impl`, `trg_impor_teto_operador` (teto de
500), `reforcar_teto_operadores`, `nivelar_medias_progressivo`,
`redistribuir_casos_operadores`, `redistribuir_casos_operadores_faixas`.
(As tres ultimas estao congeladas desde 30/07.) Do lado da simulacao,
`calibragem_simular` e `calibragem_simular_nivelamento_impl` ja excluem do pool.

### b) Automaticas que AINDA quebravam a regra — corrigidas neste PR (2)

| Funcao | Como roda | O que faltava |
|---|---|---|
| `liberar_fidelizacao_caso` | cron `fidelizacao_liberar_vencidos`, 20 8 * * * | e a ponta que solta o caso, mas o filtro dos 10 dias vive so na lista (`casos_elegiveis_liberacao_fidelizacao`). A funcao solta **qualquer** caso que receba e tem EXECUTE para `authenticated` |
| `nivelamento_automatico_gestao` | cron `nivelamento_automatico_gestao`, 20 9 * * * | monta o pool olhando encerramento, pagamento em transito e confirmacao financeira — **nao** a janela. Origem padrao e a base da gestao, mas `p_origens` aceita qualquer e-mail |

Impacto medido hoje da guarda em `nivelamento_automatico_gestao`: a base da gestao
tem **32 casos, 0 dentro do prazo** — a correcao nao muda nada do que a rotina faz
hoje; fecha o caminho.

### c) Automatica que retira sem olhar a janela — DESATIVADA neste PR (1)

`calibragem_simular_giro_2026` + `calibragem_executar_giro_lote_impl`
(+ o wrapper `calibragem_executar_giro_lote`). Como nao havera novo giro, em vez
de ensinar a fidelizacao ao giro as duas portas passam a **recusar a chamada**.
Estado antes: executaveis hoje — `simular_giro_2026` e `executar_giro_lote` com
EXECUTE para `authenticated`, `_impl` so postgres/service_role, todas atras do
portao `calibragem_e_gestao()` (3 e-mails). Nao ha tela: o giro so e alcancavel
por RPC/SQL Editor.

### d) Saida por ENCERRAMENTO, nao redistribuicao — sem alteracao

`trg_repor_caso_operador` (libera quando o caso vira fechado/quitado e enfileira
reposicao), `_talvez_quitar_aluno`, `casos_encerrar_zerados_sem_debito`,
`retirar_zerados_da_operacao`, `retirar_zerados_reais_sem_saldo`,
`confirmar_saldo_zero_retirar_filas`, `reconciliar_saldo_zerado`,
`recuperar_valor_automatico`, `prime_conferencia_encerrar_zerado_aluno`.
Todas condicionadas a saldo zero / caso encerrado — nao ha o que cobrar, entao
nao e "tirar caso do operador". (Classificadas pela condicao de entrada de cada
uma, nao por leitura linha a linha das nove.)

### e) So entrega ou devolve caso — sem alteracao

`reposicao_carteira_processar` (so pega caso com `operador_email is null`),
`devolver_operador_ao_rejeitar_confirmacao`,
`calibragem_desfazer_nivelamento_lote_impl` (desfaz para o dono anterior).

### f) Acao humana, nao rotina automatica — sem alteracao

`alterar_responsavel_aluno`, `assumir_caso_livre`, `assumir_caso_livre_aluno`,
`carteira_geral_mover`, `carteira_geral_desfazer_lote`,
`internal.carteira_geral_trocar_dono` (todas atras de portao de gestao e de uma
previa), e `trg_tabulacao_redireciona` — encaminhamento disparado pela propria
tabulacao do operador (fluxo da alegacao); travar isso quebraria o envio ao
financeiro.

### g) Cosmetico — sem alteracao

`propagar_nome_usuario`, `corrigir_nomes_operador_casos` (so nome do operador),
`girar_mensalidades_com_acordo` (escreve `operador_mensalidade_email`, **nao**
`operador_email`: nao tira o caso de ninguem).

## 2. PENDENCIA EM ABERTO — caminho indireto por alunos/acordos (fora deste PR)

`alunos.responsavel_atual_email` → trigger `_sync_casos_resp_aluno` → `casos.operador_email`.
Quem escreve o responsavel do aluno move o caso junto, sem passar pela guarda dos
10 dias. O caminho **automatico** desse canal e o trigger
`_aluno_segue_dono_do_acordo`: quando um acordo ATIVO recebe um operador e o aluno
**nao tem mensalidade em aberto**, a ficha (e o caso) segue o dono do acordo.
E a regra "o dono do acordo e o responsavel" (13/09) — mexer nela e decisao a
parte.

**Fica registrado como PENDENCIA:** mesmo com as guardas deste PR aplicadas,
ainda pode haver troca INDIRETA do responsavel do caso por decorrencia da regra
de acordos. Guardar `casos` nao fecha o caminho que entra por `alunos`. Este
fluxo sera analisado separadamente, em trabalho proprio.

## 3. Giro de 10/09/2026 — registro, sem reversao

Simulacao `c7c49f02-6e85-436b-a606-8f27945f8334` (`GIRO_2026`, criada 10/09
08:53:16 UTC, executada 08:59:49 UTC, `EXECUTADA`, 4.360 movimentacoes no JSON);
houve uma irma `23435211-13ef-4e97-b045-ff11144708a7`, **DESCARTADA**.
Efetivados **4.218 casos** (`calibragem_auditoria`, `MOVIMENTACAO_NIVELAMENTO`).

Retirados de um operador estando dentro da janela: **1.382 casos / R$ 4.338.237,26**.

| Operador de origem | Casos | Saldo |
|---|---:|---:|
| cobranca11 — Allan | 283 | R$ 794.694,44 |
| cobranca10 — João | 252 | R$ 847.266,69 |
| cobranca06 — Mauricio | 212 | R$ 509.402,16 |
| cobranca08 — Nataly | 186 | R$ 417.821,17 |
| cobranca03 — Olga | 138 | R$ 250.119,74 |
| cobranca05 — Luana | 133 | R$ 414.047,30 |
| cobranca12 — Rafaella | 111 | R$ 759.152,34 |
| cobranca13 — Diego | 67 | R$ 345.733,42 |
| **Total** | **1.382** | **R$ 4.338.237,26** |

Outros 15 casos (R$ 12.018,20) estavam na janela mas vieram **do pool** (entrada,
nao retirada) e ficam fora da conta.

Evidencia de que estavam dentro do prazo na data (duas variaveis independentes):
1. `casos.data_ultimo_acionamento` entre 31/08 e 09/09/2026 — o giro nao escreve
   nesse campo, entao quem nao foi acionado depois carrega ate hoje o valor de la;
2. **1.395 dos 1.397** tem em `aluno_movimentacoes` registro na mesma janela com
   tipo **diferente** de `ACAO_MASSIVA_EXTERNA`/`_EMAIL` — contato real, nao campanha.

Zona cinzenta declarada: outros **325** casos movidos tem `dua = 10/09`; nao da
para separar o acionamento anterior da execucao (08:59 UTC) do posterior — ficam
fora do numero.

Hoje: **1.355** desses 1.382 estao sem dono e todos ja passaram dos 11 dias.
**Nenhuma reversao foi feita nem esta proposta.**
