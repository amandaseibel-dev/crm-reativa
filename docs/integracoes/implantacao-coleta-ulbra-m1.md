# Implantação da coleta da Mensageria ULBRA: autorização M1 e roteiro

Documento para aprovação. Nada aqui foi executado. Cada etapa só começa com
autorização expressa, dada por escrito, para aquela etapa.

## Pré-condições (todas comprovadas antes da autorização)

1. PR #877 mesclada na `main`.
2. PR #878 com a base ajustada para `main`, diff contendo apenas as duas
   últimas alterações (`b527365b`, `083b4e6d`), e checks verdes no head.
3. Migration `20261109160000_ulbra_coleta_posicao.sql.pendente` revisada, com
   prova SQL (`supabase/tests/ulbra_coleta_posicao/`) verde no CI.
4. Piloto de recebimento (`20261108140000`) aplicado, porque a migration
   depende de `ulbra_sync_estado`. Hoje esse piloto **não está aplicado**, por
   isso a ordem completa inclui também ele, sujeito à mesma autorização.
5. Segredos `ULBRA_SYNC_CHAVE` e `ULBRA_MCP_TOKEN` configurados na função. Não
   são lidos nem exibidos por este roteiro.

## Sequência

| Ordem | Etapa | Efeito | Reversão |
|---|---|---|---|
| 1 | Aplicar migration `20261109160000` | Cria a coluna `offset_pendente` e a função `ulbra_sync_posicao_gravar` (service_role) | Rollback `20261109160000_ulbra_coleta_posicao.rollback.sql` |
| 2 | Publicar `ulbra-sincronizar` atualizada | A função passa a ler e gravar `offset_pendente` | Republicar a versão anterior |
| 3 | Validação manual, com teto de chamadas informado | Uma execução, sem cron | Nenhuma: a execução só lê |
| 4 | Medição de volume e orçamento | Confere o consumo real do dia | Não se aplica |
| 5 | Decisão sobre cron | Somente após 1 a 4 e aprovação da configuração | Desligar o cron |

A ordem 1 antes da 2 é obrigatória: a função nova lê a coluna.

## Validação manual (etapa 3)

- Teto de chamadas por execução, a informar antes da execução: sugestão de
  **3 chamadas** (uma `listar_conversas`, uma `ler_conversa`, uma `meu_acesso`),
  com parada obrigatória ao atingir o teto.
- Critério de aceite: ciclo `OK` ou `INCOMPLETO` com motivo registrado, posição
  gravada coerente com o pendente, e nenhuma mensagem gravada sem vínculo
  confirmado tratado como identificada.
- Consulta de estado após a execução, somente leitura, para conferir
  `ultimo_ciclo`, `piso_pendente`, `offset_pendente` e `chamadas_dia`.

## Reversão geral

- Antes do cron: reverter a função e aplicar o rollback da migration.
- Com cron ativo: desligar o cron primeiro, depois reverter a função, depois o
  rollback.
- Nunca reescrever a `main`: a reversão é um commit novo.

## Não está autorizado por este documento

Cron, merge, publicação, aplicação de migration, coleta manual além da
validação aprovada, e qualquer envio de mensagem.
