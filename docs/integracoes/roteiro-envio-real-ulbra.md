# Roteiro para o primeiro envio real pela Mensageria ULBRA

**Não executar sem aprovação expressa da gestão, por escrito, para cada etapa.**

## Pré-requisitos (todos comprovados antes)

1. Conexão OAuth individual da conta remetente, com `mensagens:enviar` na
   resposta de `meu_acesso` daquela conexão. Não usar credencial central.
2. Destinatário interno autorizado: um contato de teste da própria equipe,
   cadastrado na Mensageria e combinado com a gestão. Nunca um aluno.
3. Texto fixo e curto, já aprovado: `Teste de integração ReATIVA — pode ignorar.`
4. Custo máximo: 1 mensagem. Limite diário da pessoa: conferir `meu_acesso`
   antes e depois (`limites.pessoaPorDia.restam`).

## Procedimento

1. Confirmar o saldo diário da conta remetente. Registrar o valor.
2. Enviar uma única mensagem pelo caminho do servidor, com uma chave nova.
3. Conferir na Mensageria, pela própria tela da conta remetente: a mensagem
   existe, com o texto exato, na conversa do destinatário de teste.
4. Conferir a autoria: o autor deve ser o operador da conexão, e não a gestão
   nem uma conta central. Se o autor não bater, parar e não repetir.
5. Repetir a chave de envio. A resposta deve ser `JA_PROCESSADO`, e nenhuma
   nova mensagem deve aparecer na conversa.
6. Registrar o saldo final de `meu_acesso`. A diferença deve ser exatamente
   a chamada de envio mais as de leitura usadas.

## Critério de aceite

- Uma mensagem, texto exato, autor correto, sem duplicidade.
- Repetição da mesma chave não envia.
- Saldo consumido conferido e registrado.

## Em caso de falha

- Se o envio retornar erro sem confirmação, marcar `FALHA_INCERTA` e conferir na
  Mensageria antes de qualquer nova tentativa. Não reenviar com outra chave.
