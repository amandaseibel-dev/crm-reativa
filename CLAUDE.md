# CLAUDE.md

## Integração Prime/ULBRA

**ANTES DE QUALQUER ALTERAÇÃO, INVESTIGAÇÃO OU IMPLEMENTAÇÃO relacionada ao
Prime/ULBRA:**

1. abrir [`docs/integracoes/README.md`](docs/integracoes/README.md)
2. seguir obrigatoriamente o mapa de fontes de verdade e o catálogo documentado
3. não iniciar nova descoberta antes de verificar o que já está mapeado
4. não usar conversas ou memória como fonte primária
5. tratar `docs/integracoes/` como fonte oficial versionada da integração

## Economia de token

1. priorizar o menor consumo que preserve qualidade, segurança e precisão
2. antes de abrir subagente, varrer arquivo inteiro ou subir de modelo, seguir
   a skill `economia-de-tokens` do plugin ReATIVA One — critério objetivo de
   modelo, esforço e número de agentes
3. subir de modelo ou de esforço exige declarar, em uma linha, qual critério
   acionou

## Seleção de recursos e paralelismo

Vale em toda frente, sem precisar ser pedido:

1. antes de fazer à mão o que já existe, rotear pela skill
   `selecao-de-recursos` do plugin ReATIVA One — ela diz qual agente, skill ou
   comando atende o pedido, e o catálogo medido está em
   [`plugins/reativa-one/CATALOGO.md`](plugins/reativa-one/CATALOGO.md)
2. a **sessão principal coordena**: decide o recorte, integra e responde. Ela
   não delega a decisão, a resposta final, nem migration, merge, deploy,
   backfill e alteração financeira — esses exigem autorização específica e
   **executor único**, que é sempre a sessão principal
3. paralelizar tarefas **independentes** é o padrão, sob condição: só rodam
   juntas quando nenhuma lê o resultado da outra e **nenhuma escreve nos mesmos
   arquivos**; falhou uma condição, é sequencial. Chamadas de leitura
   independentes vão juntas, na mesma mensagem. *Quantos* agentes abrir sai do
   critério da skill `economia-de-tokens`
4. quem edita declara escopo antes da primeira edição
   (`/reativa-one:escopo`); dois editores nunca no mesmo arquivo
5. concentrar desenvolvimento, correção, teste e **commit local** numa única
   execução, dentro do escopo autorizado — não fatiar em idas e vindas
6. antes de abrir frente nova, conferir se a resposta já existe — nesta ordem:
   `supabase/ledger/` (o que de fato rodou), `docs/` pelo roteador
   `fontes-de-verdade`, `supabase/tests/`, `docs/BACKLOG-TECNICO.md`, PR
   anterior do assunto. Diagnóstico já feito não se refaz; número já provado se
   cita por `arquivo:linha`
7. alteração que toca banco — função, RPC, view, tabela, trigger, policy, grant
   ou bucket — segue a skill `seguranca-rls` antes de ser dada por concluída:
   `CREATE OR REPLACE` restaura grants padrão, e reconferir grants e
   `search_path` é item de lista, não opinião
8. não criar agente nem skill novos sem **necessidade comprovada e
   autorização**. A necessidade se demonstra contra o catálogo do item 1 —
   ganho real e **zero duplicação** do que já existe; a criação é autorizada,
   nunca presumida
9. responder de forma objetiva: resultado, testes, **bloqueios reais** e a
   próxima decisão necessária
