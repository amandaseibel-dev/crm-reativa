# Nivelamento automático de carteiras — preparação (somente leitura)

Projeto de produção: `ahattpqrjmhkzsmnbdzs`. Data: 12/11/2026.
Nada foi aplicado. Nenhuma redistribuição, reversão ou migration foi executada.

## 1. Regras confirmadas pela gestão

- **Ocupação da carteira** (define capacidade para receber casos): casos com acordo ativo, em negociação ou com acordo em andamento **ocupam vaga**.
- **Proteção contra redistribuição** (define quais casos podem sair): é outra regra. Não se reutiliza para calcular vagas.
- Somente **pagamento confirmado** libera reposição, respeitando a capacidade disponível.
- Operador no teto ou acima não recebe distribuição nem reposição automática. Não se retiram casos em massa para igualar números.

## 2. Ocupação por operador (recalculada)

Consulta: `count` de casos com `operador_email` não nulo, excluindo `caso_encerrado_operacional`. A coluna "protegidos" usa `caso_protegido_redistribuicao` apenas para informação, não para a vaga.

| Operador | Ocupação | Protegidos (dentro da ocupação) | Sairiam por redistribuição | Situação frente a 700 |
|---|---:|---:|---:|---|
| cobranca06 | 941 | 340 | 601 | acima |
| cobranca08 | 915 | 347 | 568 | acima |
| cobranca11 | 910 | 339 | 571 | acima |
| cobranca10 | 899 | 357 | 542 | acima |
| cobranca05 | 887 | 355 | 532 | acima |
| cobranca13 | 883 | 329 | 554 | acima |
| cobranca12 | 881 | 339 | 542 | acima |
| carteira.geral@reativa.local | 144 | 95 | 49 | fora do teto (conta de carteira geral) |
| cobranca07 | 15 | 15 | 0 | abaixo |
| amanda.seibel | 8 | 7 | 1 | abaixo |
| cobranca03 | 4 | 4 | 0 | abaixo |
| cobranca04 | 3 | 3 | 0 | abaixo |
| juridico | 0 | 0 | 0 | abaixo |

**Leitura:** com a regra confirmada, **os 7 operadores de cobrança estão acima de 700**. A contagem de 532–601 da versão anterior excluía os casos negociados, por isso não era a contagem correta. Não se retira caso de ninguém. Os 7 ficam bloqueados para distribuição e reposição automáticas.

**Ponto a confirmar:** `carteira.geral@reativa.local` (144) não é um operador de cobrança. Se o teto valer para ela, também está acima do teto. Precisa de decisão.

## 3. Saldo cobrável: qual referência

Rastreio pelo código e pelo banco:

- **Ficha do aluno e cobrança** (`aluno_saldo_pendente_detalhe`, `src/utils/ajusteValor.js`): para mensalidade, `coalesce(valor_cobranca_ajustado, saldo_corrigido, valor_em_aberto, valor_original, 0)`, somando títulos `ABERTO` e `NEGOCIADO` sem acordo cancelado, mais parcelas vivas de acordo não cancelado.
- **Onda 1 e calibragem**: usam `coalesce(saldo_corrigido, valor_em_aberto, valor_original, 0)`, sem `valor_cobranca_ajustado`. Divergem da ficha nos títulos com ajuste.
- **Função `saldo_titulos_aberto`**: usa só `saldo_corrigido`, sem ajuste. Divergente das duas anteriores.

Dados (títulos em aberto, sem acordo, sem tipo `Acordo`):

- 46.885 títulos.
- Só 10 têm `valor_cobranca_ajustado`; 9 deles diferem da base.
- Soma operacional (ajuste onde existe): 4.593.209.292 centavos.
- Soma base (sem ajuste): 4.596.467.117 centavos.
- Diferença: 3.257.825 centavos (R$ 32.578,25).

**Proposta:** usar a mesma referência da ficha e da cobrança, `coalesce(valor_cobranca_ajustado, saldo_corrigido, valor_em_aberto, valor_original, 0)` por título, somada por aluno, em centavos. Assim a troca "mesmo valor" bate com o que a operação cobra.

**Decisão necessária:** confirmar essa referência. Exemplo: um caso com título de R$ 1.000,00 ajustado para R$ 800,00 vale R$ 800,00 pela ficha e cobrança. Sem a decisão, a troca usaria o valor da Onda 1 (R$ 1.000,00), que não é o que a operação cobra.

## 4. Desenho da implementação (não aplicado)

1. **Capacidade:** `vagas = limite - ocupacao`. Se `vagas <= 0`, o operador não recebe distribuição ou reposição automática.
2. **Distribuição automática:** casos elegíveis livres ou da base da gestão são atribuídos a operadores ativos com `vagas > 0`, priorizando menor ocupação de casos acionáveis. Respeita fidelização, giro, atendimento em andamento, acordo em dia, link de pagamento aberto, baixa aguardando, confirmação pendente e "não acionar".
3. **Reposição:** somente após pagamento confirmado pela regra oficial. Acordo criado ou salvo, promessa e comprovante aguardando baixa não geram reposição. Cada evento de pagamento gera no máximo uma reposição (chave de idempotência por evento).
4. **Assumir atendimento no teto:** se `ocupacao >= limite`, a entrada exige saída de um caso elegível de **mesmo valor** (referência da seção 3), em transação única com bloqueio (`pg_advisory_xact_lock` e `FOR UPDATE`). Sem par elegível, a operação é recusada inteira e informa o motivo.
5. **Concorrência:** trava única para nivelamento, reposição e troca. Revalida elegibilidade e capacidade no momento da transferência.
6. **Auditoria:** cada entrada e saída vai para `calibragem_auditoria` e `historico_operadores_alunos` com origem, destino, motivo, identificador comum da troca, saldo cobrável dos dois casos e ocupação antes e depois.
7. **Gate de execução:** a execução automática roda no job diário, sem aprovação por lote, mas exige JWT ou identificação explícita de origem. Não se repete o gate `auth.jwt() is null` que deixou a Onda 1 passar.

## 5. Testes previstos (a escrever, ainda não existem)

- Operador abaixo, no limite e acima do limite.
- Negociação ou acordo ativo: ocupa vaga e não gera reposição.
- Pagamento confirmado com reposição única e respeito à capacidade.
- Assumir atendimento no teto com troca de mesmo valor.
- Ausência de par elegível: recusa total, sem escrita.
- Proteção de casos em andamento e de pagamento.
- Duas ações simultâneas: sem ultrapassar limite e sem duplicar transferência.
- Entrada e saída vinculadas nas movimentações.

## 6. Limitações e pendências

- Código, migration, testes e rollback **ainda não foram escritos**. Esta etapa fica no nível de desenho e medição.
- CI não foi executado: depende de código novo.
- Simulação com dados atuais: depende da referência de saldo (seção 3) e da decisão sobre `carteira.geral`.
- Origem da Onda 1: o banco mostra execução via conector MCP com OAuth; a identidade da pessoa não está no banco. Logs consultados; detalhes em `docs/rascunhos/ONDA1-ORIGEM-EXECUCAO-2026-10-22.md`.
- Achado de segurança: o gate `auth.jwt() is null` de `onda1_executar` aceita chamadas sem JWT. Precisa de decisão para fechar.
