# Integração Prime/ULBRA — índice

A partir de 2026-09-22, a API Prime/ULBRA é tratada como **integração
estrutural** do ReATIVA One, não como algo a redescobrir cada vez que surge um
problema operacional. Este diretório é o mapa permanente.

**Este diretório é a fonte oficial do projeto para tudo que envolva a
ULBRA/Prime.** Toda implementação que dependa de informação externa da
ULBRA/Prime consulta primeiro `docs/integracoes/README.md` (este arquivo).
**Conversas anteriores não são fonte primária** — a documentação versionada
é o conhecimento permanente da integração; se um chat souber algo que não
está aqui, o chat está desatualizado, não o contrário.

**Regra obrigatória, para todo desenvolvimento futuro.** Antes de criar
qualquer regra, fallback, inferência, sincronização ou rotina financeira
baseada em dado do Prime:

```
1. consultar docs/integracoes/README.md (este arquivo)
2. consultar prime-mapa-fontes-verdade.md
3. identificar o endpoint/fonte oficial (prime-api.md / prime-api-catalog.json)
4. validar o identificador correto (prime-mapa-identificadores.md)
5. verificar limitações já documentadas (prime-api.md, prime-gaps.md)
6. só então implementar ou investigar
```

**Nunca iniciar uma nova descoberta de API sem antes verificar o catálogo
existente.** Nunca reconstruir informação financeira por aproximação quando a
documentação indicar que existe, ou pode existir, uma fonte oficial.

**Quando uma rota, campo, limitação, identificador, Edge Function ou fonte de
verdade nova for descoberta**, atualizar **na mesma alteração**:
`prime-api.md` + `prime-api-catalog.json` + `prime-mapa-fontes-verdade.md` +
`prime-mapa-identificadores.md` (quando aplicável) + `prime-gaps.md` (quando
aplicável). Nunca só um dos cinco.

## Documentos

| Arquivo | Para que serve |
|---|---|
| [`prime-api.md`](prime-api.md) | Manual humano, endpoint por endpoint: finalidade, parâmetros, retorno, fonte de verdade, limitações, segurança, automação, fallback, o que nunca inferir |
| [`prime-api-catalog.json`](prime-api-catalog.json) | O mesmo conteúdo, machine-readable, para consumo por ferramenta/automação/teste |
| [`prime-mapa-fontes-verdade.md`](prime-mapa-fontes-verdade.md) | Matriz INFORMAÇÃO → FONTE OFICIAL → ENDPOINT → CHAVE |
| [`prime-mapa-identificadores.md`](prime-mapa-identificadores.md) | Toda relação entre CPF, matrícula CRM, `registration` Prime, `documentNumber`, boleto, número Ulbra — quem gera, se é único/estável, se serve para matching |
| [`prime-edge-functions.md`](prime-edge-functions.md) | Inventário completo das Edge Functions que tocam Prime/ULBRA, incluindo as 6 que existiam só em produção e foram versionadas nesta auditoria |
| [`prime-arquitetura.md`](prime-arquitetura.md) | Diagrama lógico: CRM → Edge Functions → API Prime → banco; caminhos de leitura/escrita; pontos cegos |
| [`prime-gaps.md`](prime-gaps.md) | Tabela VERDE/AMARELO/VERMELHO de cada informação necessária, e a resposta à pergunta da estrutura financeira dos acordos |

Ver também `docs/PREMISSAS.md` (Premissas 19 e 20, seção "Acordo") — é onde
vive a evidência medida, título a título, da investigação da estrutura do
acordo. Os documentos deste diretório resumem e apontam para lá em vez de
duplicar.

## Resposta direta: onde está a estrutura financeira dos acordos

**Não localizada em nenhuma rota da API Prime/ULBRA testada.** A tela do
Prime mostra a estrutura completa (visto e conferido título a título no
acordo 71903, 15/09/2026), então **o dado existe** — o que não foi
identificado é a URL estruturada que essa tela consome. É uma limitação de
**escopo da superfície pública testada com a chave atual**, comprovada com
evidência (inclusive `agreements: []` para um acordo confirmado ATIVO na tela
no mesmo instante da chamada), não uma afirmação de que a ULBRA não tenha o
dado em algum lugar. Detalhe completo em
[`prime-gaps.md`](prime-gaps.md#a-resposta-à-prioridade-imediata).

**Nenhuma regra financeira nova foi criada** durante este mapeamento, conforme
pedido — inclusive o teste de consistência descrito na Premissa 20
(`Σ(paidAmount − grossAmount) == Σ(valor_pago) − Σ(honorário)`) continua
classificado como teste de verificação, não regra de reconstrução.

## Como manter isto atualizado

1. **Toda descoberta nova** (endpoint, campo, comportamento, limite) atualiza
   `prime-api.md` + `prime-api-catalog.json` + `prime-mapa-fontes-verdade.md`
   **no mesmo commit** — os três nunca ficam dessincronizados.
2. **Toda Edge Function nova** que toque Prime/ULBRA entra em
   `prime-edge-functions.md` no mesmo commit em que é criada — nunca depois.
3. **Qualquer sondagem de rota nova** usa `prime-sonda` (versionada em
   `supabase/functions/prime-sonda/`), nunca um script ad-hoc com a chave
   colada — e o resultado (mesmo negativo) entra neste diretório.
4. **Teste de contrato** (`src/utils/primeApiContrato.test.js`) verifica que o
   entendimento aqui documentado sobre a FORMA das respostas continua
   codificado — se um campo mudar de nome/tipo em produção, atualizar a
   fixture do teste é o gatilho para atualizar este diretório também.
5. **Revisão periódica recomendada, não implementada nesta etapa:** rodar
   `prime-sonda` mensalmente contra os 6 endpoints confirmados
   (`carriers`, `students_search`, `student_composite`, `student_contracts`,
   `financial_statement`, `agreements`) e comparar a FORMA da resposta com a
   documentada aqui. Não foi automatizado para não criar um novo cron em
   produção sem aprovação explícita da gestão — ver `docs/BACKLOG-TECNICO.md`.

## O que este mapeamento NÃO fez (por desenho)

- Não criou, alterou nem aplicou nenhuma regra financeira nova.
- Não deu baixa, não alterou acordo, não fez backfill.
- Não aplicou migration nenhuma em produção — o drift de banco encontrado
  (`prime_chave_api()`, `prime_extrato`, `prime_extrato_fila` sem migration;
  `prime_mensalidades_sync` órfã) está documentado em `prime-gaps.md` como
  item de backlog, não corrigido.
- Não reimplantou nenhuma Edge Function — as 6 que existiam só em produção
  foram **copiadas para o repositório**, não modificadas nem reimplantadas.
- Não chamou a API Prime diretamente a partir desta sessão. Toda evidência
  usada aqui vem de código já em produção, memórias de sessões anteriores
  (medições já feitas, citadas com data) e `docs/PREMISSAS.md`.
