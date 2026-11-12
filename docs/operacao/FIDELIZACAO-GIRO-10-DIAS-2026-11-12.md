# Fidelização do giro de outubro segue os 10 dias (12/11/2026)

**Status:** migration PENDENTE, nada aplicado em produção. Nenhuma liberação
executada, nenhum giro, nenhuma redistribuição.
Arquivos: `supabase/aguardando_aprovacao/20261112210000_fidelizacao_giro_segue_os_10_dias.{sql.pendente,rollback.sql}`,
teste `supabase/tests/fidelizacao_giro_segue_os_10_dias.test.js` (46 testes).
**Sem alteração de tela** nesta PR (ver "Tela").

## Regra definitiva (gestão, 12/11/2026)

1. Fidelização de 10 dias, inclusive para caso do giro de outubro.
2. A partir do 11º dia sem interação válida o caso perde a exclusividade.
3. Fica disponível ao receptivo e elegível às Ações Massivas, respeitando as demais proteções.
4. Sem novo giro e sem redistribuição automática.
5. Preservar acordos, atendimentos em andamento, retornos e outras proteções legítimas.
6. A marca histórica do giro não mantém fidelização indefinida.
7. "Perdendo o caso" reflete a disponibilidade real, não só dias.

## Causa (medida em PROD, 12/11, somente leitura)

`liberar_fidelizacao_caso` e `trg_impor_teto_operador` decidem pela **marca**
`casos.giro_fidelizacao_ate` (não nula = blindado), não pela **data**. As datas
venceram em 26/10 (3.645 casos) e 31/10 (215), mas a marca só sai quando o dono
muda. O cron 8 (`fidelizacao_liberar_vencidos`, 05:20 BRT) roda todo dia com
sucesso e devolve `false` para todos eles. `assumir_caso_livre` tem o defeito
oposto: marca vencida deixa outro operador tomar o caso **sem olhar os 10 dias**.

## O que a migration muda (4 funções, patch ancorado, zero DML)

| Função | Mudança |
|---|---|
| `liberar_fidelizacao_caso` | guarda do giro olha a DATA (`caso_em_giro_fidelizacao`); retorno agendado pelo operador (hoje ou futuro, origem `OPERADOR%`, como `utils/retornoOrigem.js`) preserva o caso; portão interno de gestão/cron (a função era `SECURITY DEFINER` com `EXECUTE` para `authenticated` sem conferir quem chama) |
| `trg_impor_teto_operador` | marca nua → data |
| `assumir_caso_livre` | caso de giro com dono só é assumível após os 10 dias do último acionamento |
| `casos_risco_perder` | giro vigente e retorno do operador saem do card "risco de perder" (não são risco). **Não é espelho exato do cron:** o card ainda lista caso da Carteira Geral e caso em hold de 24h, que a liberação não solta (achado do Guardião). Regra no banco (Premissa 12) |

Não muda: `caso_protegido_redistribuicao`, `caso_encerrado_operacional`,
congelamento, hold de 24h, `casos_elegiveis_liberacao_fidelizacao`,
Ações Massivas, nivelamento, cron, grants, dono,
`search_path`. O bloco final **aborta** se grant/dono/search_path mudar.
Rollback devolve os 4 corpos byte a byte (md5 de produção) e recusa rodar se a
função mudou. Ele **não** devolve ao operador o que a rotina já tiver soltado
(isso é DML, por lista de ids de `historico_operadores_alunos`, com autorização).

## Significado de `protegido_contra_redistribuicao`

Não existe coluna com esse nome. É a função `caso_protegido_redistribuicao(...)`,
que devolve `true` para: `nao_acionar`; jurídico/cancelado; confirmação financeira
aberta ou título em confirmação Prime; acordo `ATIVO`; baixa/link de pagamento em
trânsito; quitação com saldo zerado; e status de tratativa (acordo fechado/em
andamento, em negociação, aguardando pagamento/financeiro, proposta, termo, link
cartão, valores enviados, pago parcial, em tratativa, **retorno agendado**).
É a proteção legítima. Tudo isso continua valendo.

## Conciliação 1.529 × 1.491

São populações diferentes e ambas se mexem todo dia (medido agora: 1.612 parados
há 11+ dias ou nunca acionados, com operador):

- **1.529** ≈ nível `PERDENDO` com data (1.527 hoje) → **inclui a Carteira Geral** (121 casos).
- **1.491** ≈ parados 11+ dias **fora da Carteira Geral** (1.486 hoje) → inclui 75 casos que o nível armazenado ainda não marca como PERDENDO (recálculo só às 06:00).
- Conta: 1.612 − 126 (Carteira Geral) = 1.486; 1.527 − 121 + 75 + 5 (nunca acionados) = 1.486.
- Não consegui reproduzir os valores exatos de 1.529/1.491 porque a base muda diariamente; a diferença de 38 é explicada por essas duas fronteiras.

## Universo final (simulação em PROD, 12/11 ~14h, somente leitura)

Casos que **perderiam a exclusividade na 1ª rodada do cron 8**: **969** · saldo R$ 1.213.436.

| Operador | Liberam | Saldo (R$) |
|---|---|---|
| cobranca13 | 343 | 532.913 |
| cobranca06 | 278 | 398.176 |
| cobranca05 | 179 | 113.289 |
| cobranca12 | 162 | 160.389 |
| cobranca08 | 3 | 682 |
| cobranca11 | 3 | 7.142 |
| cobranca10 | 1 | 845 |

Garantias medidas: **0** com acionamento válido nos últimos 10 dias (por
`data_ultimo_acionamento` e por movimentação `FINALIZACAO_ATENDIMENTO` /
`ACAO_MASSIVA_EXTERNA*`); 2 nunca acionados; todos com marca de giro vencida.

Ficam de fora (e continuam com o operador), dos 4.009 casos com marca fora da Carteira Geral (1ª medição): 2.642
ainda dentro dos 10 dias e 338 protegidos; os 1.029 restantes eram os soltáveis. Na 2ª medição, já com a guarda de retorno,
esses 1.029 viraram 969 que liberam + **63 com retorno marcado pelo operador para hoje** (todos da cobranca06) +
1 no hold de 24h = 1.033; a diferença de 4 casos é a base viva entre as duas consultas (minutos), não erro de conta.

Pontos a saber:
- 966 dos retornos futuros são `AUTOMATICO` (carimbo das Ações Massivas) e **não** protegem: não são compromisso do operador.
- 14 alunos têm `status_jornada = EM_ATENDIMENTO` parado desde junho: marca velha, não é atendimento em andamento; não protegem.
- Quem tem marca e ainda está dentro dos 10 dias continua protegido; sai sozinho no 11º dia (efeito diário, sem novo giro).

## Impacto

- **Carteira:** o operador perde exclusividade, mas o caso fica **livre**, sem dono; `responsavel_atual_*` é zerado e o último acionamento é preservado. O histórico registra `FIDELIZACAO_EXPIRADA` com o responsável anterior.
- **Receptivo:** passa a poder assumir esses casos (`assumir_caso_livre`); o teto e as proteções continuam valendo. Atenção ao pico: 969 casos livres de uma vez, 4 operadores concentram 96%.
- **Ações Massivas:** já tratam `resp is null` como livre e só protegem pelos 10 dias em BRT (`acoes_massivas_fidelizacao_protege`); os 969 entram no universo `livres` sem mudança de código.
- **Reposição de carteira (job 43):** segue **pausado**; a migration não o toca. Se for religado, vai preencher as carteiras com os livres: decisão separada.
- **Card "Sem acionamento (risco de perder)":** vem de `casos_risco_perder`; deixa de contar giro vigente e retorno do operador como risco, mas **não** é a disponibilidade exata (inclui Carteira Geral e hold de 24h) — item 7 só parcialmente atendido. Hoje a RPC devolve 1.082 linhas para a gestão: **acima do corte de 1.000 da API**, e a tela chama sem paginar (achado do Guardião; falha silenciosa para a gestão). Não mexi nisso aqui; é pendência declarada.
- **Tela (selo por linha "Perdendo o caso (Nd)" e faixa de prioridade):** **não alterada**. Uma primeira versão decidia isso no `.jsx`; foi **descartada** porque (a) viola a Premissa 12 (regra no banco, não na tela) e (b) dependia da lista da RPC, que passa de 1.000 linhas. O selo por linha segue contando dias até haver, no banco, uma coluna que diga se o caso pode ser solto. Follow-up proposto, fora desta PR.

## Recomendação de implantação segura

1. Revisar e autorizar a migration (linha M1 própria; **não** coberta por autorização anterior).
2. Aplicar **fora do expediente**, em transação, com o bloco de retrato (grants/dono/search_path) como portão. Pré-requisito: conferir `md5(prosrc)` das 4 funções = `de8a3b43…`, `3d01bbd1…`, `607a8b4f…`, `702279a5…` (as do rollback). Grants de produção em 12/11: `{postgres, authenticated, service_role}` em todas, sem PUBLIC.
3. **Não liberar tudo de uma vez.** O cron 8 solta o lote inteiro sozinho às 05:20 BRT. Antes da aplicação, decidir: (a) deixar o cron soltar os 969 e avisar os 4 operadores e o receptivo; ou (b) aplicar a migration com o cron 8 pausado, e liberar em lotes por `liberar_casos_fidelizacao_vencida(p_limite)`, conferindo a cada lote. Recomendo **(b) em 3 lotes**, começando por cobranca13.
4. Backup por id da lista dos 969 antes de qualquer liberação (é o que permite devolver ao operador).
5. Conferir depois: 0 caso com acionamento ≤10 dias solto; 0 caso protegido solto; contagem por operador igual à simulação; grants das 4 funções inalterados.
6. Rollback: o do arquivo. Para devolver casos já soltos: lista por id, autorização própria.

## Não comprovado

- Gate de segurança do repositório (`run_security_gate.sh`) não rodou: `psql` ausente nesta máquina.
- Tela: não alterada.
- Produção hoje só tem `retorno_origem` = `AUTOMATICO` e `OPERADOR` (593 com retorno hoje ou futuro); `OPERADOR_EM_CONFIRMACAO` não existe agora, mas a guarda usa prefixo por segurança.
- Plano de execução do cron com 969 casos não medido em PROD (loop com 1 `UPDATE` + 1 `INSERT` por caso, `statement_timeout` de 180 s da função).
