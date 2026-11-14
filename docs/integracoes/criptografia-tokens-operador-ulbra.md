# Armazenamento e chave dos tokens OAuth por operador (recomendação)

Recomendação técnica para revisão. Não aplicar antes da revisão da gestão e
da TI, porque depende de a TI confirmar o cadastro do cliente OAuth.

## Recomendação

1. **Chave fora do banco.** Uma chave simétrica AES-256-GCM, gerada uma vez,
   guardada como segredo da função (`ULBRA_TOKEN_CHAVE`), nunca em tabela,
   migration, log ou arquivo de repositório.
2. **Cifragem na aplicação, não no banco.** A função cifra antes de gravar e
   decifra só no momento do uso. Cada registro tem IV único e uma versão de
   chave (`chave_versao`), para permitir rotação sem reescrever tudo de uma vez.
3. **Armazenamento.** Colunas `*_cifrado` em `ulbra_conexoes_operador`, com RLS
   ligada e sem política para `authenticated`/`anon`. Só `service_role` lê e
   escreve, como já previsto na migration `20261109170000`.
4. **Refresh token rotacionado.** Cada renovação grava o novo refresh e
   descarta o anterior no mesmo passo. Se o provedor reutilizar um refresh já
   trocado, a conexão é marcada como revogada e o operador é avisado.
5. **Renovação antecipada.** O access token é renovado quando faltarem menos de
   5 minutos (`MARGEM_MS` em `conexao.ts`). Falha de renovação bloqueia o envio.
6. **Revogação.** Desconectar marca `revogada_em` localmente e chama o endpoint
   de revogação do provedor. Falha no provedor não libera o envio: a conexão
   local continua bloqueada, e a falha fica registrada.
7. **Rotação da chave.** Trocar `ULBRA_TOKEN_CHAVE` com nova `chave_versao`,
   recifrar em lote por função de servidor, e só então desativar a chave
   antiga. Testar a rotação num Postgres isolado antes.
8. **Logs.** Nunca registrar token, refresh ou texto de mensagem. Registrar só
   identificador da conexão e motivo.

## O que a gestão precisa decidir

- Quem pode solicitar rotação de chave (recomendação: somente a gestão, com
  registro em `auditoria`).
- Tempo máximo de conexão sem uso antes de expirar (recomendação: 30 dias).

## Bloqueio externo

O cadastro do cliente OAuth, e os escopos concedidos à conexão individual,
dependem da TI da ULBRA. Nenhuma decisão de chave libera o envio sem essa
resposta.
