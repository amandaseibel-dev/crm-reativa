# Implantação da coleta da Mensageria ULBRA: autorização M1 e roteiro

Documento para aprovação. Nada aqui foi executado. Cada etapa só começa com
autorização expressa, dada por escrito, para aquela etapa.

## 1. Piloto de recebimento: já aplicado, não reaplicar

Reconfirmado em produção por leitura, em 09/11/2026:

- `supabase_migrations.schema_migrations` tem a versão `20261108204402`, com
  nome `20261108140000_ulbra_recebimento_e_fila`.
- O arquivo do repositório `supabase/ledger/2026-11/20261108204402__20261108140000_ulbra_recebimento_e_fila.sql`
  tem SHA-256 `ccf3b206bd829f08…`, igual ao SHA do arquivo
  `supabase/aguardando_aprovacao/20261108140000_ulbra_recebimento_e_fila.sql.pendente`
  na `main`.
- O índice `supabase/ledger/2026-11/INDICE.tsv` registra a versão.

Conclusão: o piloto está aplicado como `20261108204402`. **Não entra na nova
autorização e não deve ser reaplicado.**

A comparação de conteúdo do statement de produção com o arquivo não foi feita
byte a byte. Só o nome, a versão e o SHA do arquivo foram conferidos.

## 2. Escopo desta autorização

Somente a migration incremental `20261109160000_ulbra_coleta_posicao`, depois
do merge da PR #877 (correção da coleta) e da PR #878 (retomada do backlog,
com base ajustada para `main`).

## 3. Teto por execução: comprovado no código

- A função `ulbra-sincronizar` aceita `teto_chamadas` (inteiro de 1 a 12) no
  corpo da requisição. Sem o campo, a execução usa só o teto diário, como o cron
  faz. Valor inválido responde 400.
- O teto é aplicado pelo `Orcamento`: cada chamada consome uma unidade, e
  nenhuma leitura é feita com saldo zero. Teste em
  `supabase/functions/ulbra-sincronizar/posicao-backlog.test.ts`.
- O teto **não** é diário: é de execução. O diário continua em
  `TETO_DIARIO_SYNC` (440).

### Por que o teto proposto é 6, e não 3

Com teto 3, a primeira execução gasta a chamada de `meu_acesso` (o cache de saldo
começa vazio), depois a página nova e o salto, e não sobra leitura para o backlog.
A retomada não seria testada. Com teto 6, a execução tem leitura para retomar.

### Custo máximo por execução com teto 6

| Chamada | Quando ocorre | Máximo |
|---|---|---|
| `meu_acesso` | só se o cache de saldo venceu (60 min) | 1 |
| `listar_conversas` | páginas novas e o salto, com uma chamada reservada ao detalhe | 5 (mesmo que o teto restante) |
| `ler_conversa` | detalhe de uma conversa, com a reserva | 1 |
| `listar_atendimentos` | só se o teto ainda tiver saldo ao chegar nela | 1 |
| **Total** | | **6** |

Em todas as chamadas, o teto é checado antes de sair. Nenhuma passa de 6.

## 4. O que a execução faz no ReATIVA

A execução **lê** a Mensageria ULBRA e **grava** no ReATIVA:

- espelho de conversas (`ulbra_conversas`) e de atendimentos;
- fila de detalhes e pendências de detalhe;
- estado da coleta (`ulbra_sync_estado`: janela, saldo, contador do dia);
- posição de leitura (`offset_pendente`).

Não envia mensagem, não assume atendimento e não altera cadastro.

## 5. Teste de retomada e aprovação antes da execução

Proposta de teste, a aprovar antes de qualquer execução real:

1. **Simulado (já coberto no código):** backlog de 1000 com teto 6, cobertura
   total entre execuções, sem estouro de teto.
2. **Real, duas execuções manuais, teto 6 cada:**
   - custo máximo: 12 chamadas no total, mais as gravações no banco;
   - critério de aceite: a primeira execução grava `offset_pendente` ou fecha o
     ciclo, a segunda retoma a partir dele, e nenhuma execução passa de 6;
   - conferência, somente leitura, de `ultimo_ciclo`, `piso_pendente`,
     `offset_pendente` e `chamadas_dia` após cada execução.
3. Cada execução real exige aprovação separada, com o número exato de chamadas
   e o horário. Sem cron.

## 6. Sequência

| Ordem | Etapa | Efeito | Reversão |
|---|---|---|---|
| 1 | Aplicar migration `20261109160000` | Cria `offset_pendente` e `ulbra_sync_posicao_gravar` (service_role) | `20261109160000_ulbra_coleta_posicao.rollback.sql` |
| 2 | Publicar `ulbra-sincronizar` atualizada | A função lê e grava `offset_pendente` e aceita `teto_chamadas` | Republicar a versão anterior |
| 3 | Validação manual, duas execuções de teto 6 | Lê a ULBRA e grava no ReATIVA | Nenhuma reversão; o estado pode ser corrigido por função de servidor, se preciso |
| 4 | Medição de volume e orçamento | Confere o consumo do dia | Não se aplica |
| 5 | Decisão sobre cron | Só após 1 a 4 e aprovação da configuração | Desligar o cron |

A ordem 1 antes da 2 é obrigatória: a função lê a coluna nova.

## Reversão geral

- Antes do cron: reverter a função e aplicar o rollback da migration.
- Com cron ativo: desligar o cron, reverter a função, depois o rollback.
- Nunca reescrever a `main`: a reversão é um commit novo.

## Não está autorizado por este documento

Reaplicação do piloto, cron, merge, publicação, migration, execução real e
qualquer envio de mensagem.
