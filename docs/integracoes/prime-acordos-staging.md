# Staging da integração ACORDOS (Mannesoft Prime → ReATIVA One)

Consolida as decisões das rodadas de diagnóstico sobre identidade, composição
e atualização financeira dos ACORDOS, e registra o escopo desta primeira
etapa de desenvolvimento. Ver [prime-arquitetura.md](prime-arquitetura.md)
para o diagrama geral da integração Prime/ULBRA — este documento cobre só a
frente de ACORDOS, que **não é** a estrutura financeira hoje lida pela API
(ver [prime-mapa-fontes-verdade.md](prime-mapa-fontes-verdade.md), linha
"Estrutura do acordo").

## Decisões já fechadas (não reabrir)

1. **Identidade do acordo** = número do acordo no Mannesoft + identificador
   estável do aluno (CPF). **Carteira/portador nunca é parte da chave** —
   não foi comprovado que um acordo fica preso à mesma carteira durante todo
   o seu ciclo de vida, e tratá-la como identidade arriscaria duplicar o
   mesmo acordo caso ela mude entre duas capturas. É atributo versionado.
2. **`numero_ulbra` não é chave única.** Medido em produção: 20,1% dos
   5.055 acordos sem valor, 17 valores repetidos com status conflitantes
   entre si (ex.: um ATIVO + um CANCELADO do mesmo número). Nunca usado como
   identidade nesta integração.
3. **`duplicado_de`/`duplicado_marcado_em` não são reutilizados.** Têm dono
   já wired em produção (`tg_acordo_bloquear_duplicado`,
   `acordos_sinalizar_boleto_repetido`), lidos por `acordos_duplicados_sinalizados()`
   (tela de gestão) e por `tv_snapshot_atualizar()` (ranking de operadores na
   TV). Escrever neles por fora interferiria nos dois.
4. **Composição = grupo, nunca correspondência individual.** A integração
   preserva o conjunto de títulos negociados e o conjunto de títulos gerados
   exatamente como a tela do Acordo-Detalhe mostra. Nunca inventa qual
   título negociado específico foi substituído por qual título gerado
   específico além do que o Mannesoft explicitar — é exatamente o erro já
   invalidado em produção (regra de `paymentDate` igual = mesmo acordo,
   revertida em 1.217 vínculos; correspondência por últimos dígitos do
   boleto, 56,3% de acerto).
5. **Quitação observada no Mannesoft nunca aciona baixa.** `quitar_acordo_cartao()`
   grava uma baixa como se o pagamento tivesse ocorrido agora, neste
   sistema — usá-la para refletir algo só observado no Mannesoft forjaria um
   evento financeiro que não aconteceu aqui. Gera alerta, sempre.
6. **Toda atualização financeira passa por rotina oficial, nunca `UPDATE`
   direto**: acordo novo → `importar_acordos()`; cancelamento → `cancelar_acordo_ficha()`
   (nunca `acordo_cancelar()`, que não tem a guarda de permissão nem o
   bloqueio tudo-ou-nada); confirmação → molde de
   `fila_acordos_confirmar_automatico()`; vínculo de título → `acordo_vinculo_sugestao_confirmar()`,
   só quando o nível calculado por `acordo_vinculo_sugestoes_calcular()` for
   `FORTE`.
7. **Indeterminado = exceção**, nunca automático por omissão — mesmo
   princípio do Guardião (`plugins/reativa-one/hooks/guardiao.sh`:
   "INDETERMINADO = NEGA").

## O que esta etapa entrega

- `supabase/propostas/PROPOSTA_staging_acordos_prime.sql` — proposta de
  schema (não aplicada): `acordos_prime_staging` (histórico append-only por
  chave de acordo), `acordos_prime_staging_criticas` (exceções próprias,
  nunca a tabela de crítica da importação de boletos) e a view
  `acordos_prime_staging_atual`.
- `supabase/functions/_shared/prime-acordos-staging.ts` — lógica pura
  (identidade, hash de composição, comparação de versões, classificação de
  caso, classificação de segurança fail-closed, transformação proposta para
  o formato de `importar_acordos()`). Sem rede, sem Supabase, sem RPC —
  mesmo padrão de `pdf.ts`.
- `supabase/functions/_shared/prime-acordos-staging.test.js` — testes com
  dados fictícios cobrindo as 7 decisões acima.

Nada neste commit lê ou escreve em `acordos`, `acordos_titulos`, `parcelas`
ou `baixas_pagamento`. Nada altera o importador atual de boletos/pagamentos.

## Dependências que ainda impedem a sincronização automática completa

| Dependência | Por que bloqueia | Quem decide |
|---|---|---|
| **Autorização para automatizar a extração das páginas do Mannesoft** | Sem ela não há captura real nenhuma para alimentar o staging — é a Etapa 0 de todas as rodadas anteriores. Não solicitada aqui. | Gestão/TI |
| **Validação da identidade na primeira captura real** | A unicidade do número do acordo do Mannesoft só é verificável com dado real; hoje nenhuma coluna do CRM guarda esse valor para cruzamento. O autodetector de colisão (índice `idx_acordos_prime_staging_colisao_lote`) está pronto, mas não testado contra captura real. | Primeira execução supervisionada |
| **Validação do formato aceito por `importar_acordos()`** | `transformarParaImportarAcordos()` é proposta, não contrato comprovado — a função devolve `pendenciasValidacao` a cada chamada listando o que falta confirmar (encoding de `acordo_base`, regra de CPF quitado, etc.). | Teste dirigido contra ambiente real, fora desta etapa |
| **Critério real de nível `FORTE`** em `acordo_vinculo_sugestoes_calcular()` | Não foi inspecionado nesta rodada se a composição vinda do Prime algum dia se qualifica como `FORTE` sob essa lógica, ou se cairá sempre em conferência manual. | Leitura da rotina real, antes de depender dela em produção |
| **Decisão de gestão sobre quitação observada externamente** | Não existe hoje rotina oficial que signifique "aplicar um status só observado externamente, sem fabricar um evento local". Fica como alerta até essa decisão existir. | Gestão |
| **RLS/grants do staging** | Esta proposta de schema deliberadamente não inclui RLS — precisa passar pela skill `seguranca-rls` antes de qualquer aplicação real. | Revisão de segurança, antes de aplicar a migration |
| **Identidade de serviço autorizada** para acionar as rotinas oficiais (`importar_acordos`, `cancelar_acordo_ficha`, etc.) a partir desta integração | Precisa de uma identidade formalmente autorizada por gestão (molde do `confirmacao-automatica@sistema` já em uso), não de um atalho que pule a checagem de permissão. | Gestão |

Nenhuma dessas dependências bloqueia o que já foi entregue nesta etapa —
ficam documentadas para a próxima decisão, sem impedir o resto do
desenvolvimento.
