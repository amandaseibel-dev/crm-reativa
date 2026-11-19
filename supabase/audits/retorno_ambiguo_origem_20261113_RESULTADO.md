# Origem da data de retorno dos casos ambíguos — saída medida

**Consulta:** `supabase/audits/retorno_ambiguo_origem_20261113.sql` (somente leitura)
**Produção** `ahattpqrjmhkzsmnbdzs` · **medido em 13/11/2026 15:31 (São Paulo)** · papel `postgres`, nenhum DML.

> Retrato de base viva. O universo muda a cada hora — remedir na janela de execução.

## Universo no instante da medição

| Item | Valor |
|---|---|
| Elegíveis | **565 casos / 548 alunos** |
| Liberáveis (sem proteção e sem ambiguidade) | **509 casos** |
| **Ambíguos (retidos, fora da liberação)** | **56 casos / 55 alunos** |

A medição anterior (13/11 13:37) dava 575 casos / 558 alunos / 518 liberáveis / 57 ambíguos. A diferença é a base andando entre as duas leituras, não mudança de regra.

## Qual sinal retém cada caso

| Sinal de ambiguidade | Casos |
|---|---|
| Atendimento do responsável menciona **outra** data de retorno | **56** |
| Nenhum atendimento do responsável atual | **0** |

## Sinais da data vigente

| Sinal | Resultado |
|---|---|
| `data_retorno` = **hoje** | **56 de 56** |
| `data_retorno` no futuro | 0 |
| `retorno_origem` | `OPERADOR` em 56 de 56 |
| Texto do atendimento cita data **já vencida** | **56 de 56** |

## Leitura — o que isto prova e o que não prova

**Prova:** nenhum dos 56 tem data futura; todos têm a data vigente igual ao dia da medição; em todos, o texto do atendimento do próprio responsável aponta uma data **anterior**, já vencida.

**Não prova:** quem gravou a data vigente. O conjunto é **compatível** com o recálculo automático investigado na [#949](https://github.com/ReATIVA/crm-reativa-atual/pull/949) — que reescreve `data_retorno` para o dia corrente —, mas **compatibilidade não é causa**: não há grupo de controle medido de retornos sabidamente humanos para comparar.

**Sinal que NÃO existe e não deve ser citado:** `alunos.data_retorno` é do tipo `date` e nunca guardou hora. Qualquer leitura do tipo "nenhum tem hora, logo é automático" é vazia por construção — conferido no catálogo de produção em 13/11/2026. Uma afirmação anterior deste pacote se apoiava nesse sinal; foi retirada.

**Decisão que decorre:** os 56 ficam **fora da liberação** (`retorno_ambiguo_decisao_pendente`), porque a origem da data não está estabelecida e soltar sem isso arrisca tirar do operador um compromisso real. A retenção vale no backup **e** na hora de soltar. A decisão sobre eles espera o fechamento da #949.
