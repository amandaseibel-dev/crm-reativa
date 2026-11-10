# Histórico somente leitura da conversa (Central ULBRA)

Status: PREPARADO. Não publicado, não ligado à tela, migration não aplicada.

## O que a leitura faz, em ordem
1. **Identidade:** o aluno tem CPF confirmado (`aluno_id`). Sem isso, nada é lido.
2. **Autorização:** o operador é dono da carteira ou responsável comprovado pelo atendimento, com dados lidos do banco no momento da leitura. Enxergar o caso na Central não basta: ver não é responder.
3. **Cache:** página já lida nos últimos 5 minutos custa zero chamadas. Cache em memória é só otimização; o limite vale no banco.
4. **Saldo:** a fotografia do saldo (`ulbra_sync_estado.saldo_api_restam`) vale 15 minutos. Sem medida ou com medida vencida, a leitura bloqueia.
5. **Reserva atômica:** cada chamada externa reserva 1 unidade no banco (`ulbra_historico_reservar`) antes de sair. Conta por operador e global, entre instâncias e requisições simultâneas. "Carregar anteriores" também reserva.
6. **Leitura:** `ler_conversa` com a credencial de backend, 20 mensagens por página.

## Valores propostos (não ativados)
| Parâmetro | Valor proposto | Quem decide |
|---|---|---|
| Limite por operador por dia | 20 chamadas | gestão |
| Reserva global | 100 do saldo medido | gestão |
| Validade da fotografia do saldo | 15 minutos | gestão |
| Cache | 5 minutos | técnico |

O teto global do histórico é `saldo medido − 100`. O saldo é uma fotografia: a coleta também gasta, e esse gasto não entra na reserva do histórico. Por isso a reserva é uma proteção aproximada, não um teto exato.

## O que a resposta comprova e o que não comprova
- **Comprova:** identidade confirmada, carteira ou responsabilidade lidas do banco no momento, reserva feita antes da chamada, validade da fotografia do saldo.
- **Não comprova:** que a credencial de backend enxerga toda conversa (conversa fora do alcance vira "histórico indisponível", nunca "vazio"); que a cota do backend é separada da cota de OAuth da gestão.
- `meu_acesso` **não** prova alcance de todas as conversas nem compartilhamento de cota. Ele mostra o saldo e os limites da pessoa do token.

## Autoria
A leitura não exige conexão individual de operador. O envio exige conexão individual com autoria: isso fica fora desta frente, e a credencial central nunca envia.

## Migration pendente
`supabase/aguardando_aprovacao/20261110100000_ulbra_historico_orcamento.sql.pendente`, com rollback. Cria só a contagem diária e a função de reserva. Não guarda texto de mensagem. Não é a tabela de tokens.

## Para ligar (depois da validação da coleta, com autorização)
1. Validar com `meu_acesso` (somente leitura) o escopo de conversas do token de backend.
2. Aplicar a migration da contagem, com autorização.
3. Publicar a função `ulbra-historico`, com autorização.
4. Teste com um operador piloto e teto de 20 chamadas, com aprovação de cada execução.
