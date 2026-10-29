# Preview da seção "Situação acadêmica consultada no Prime"

```bash
npx vite --config vite.preview-academico.config.js
# abre http://localhost:5198/preview-academico.html
```

O **componente é o real** (`src/components/SituacaoAcademicaPrime.jsx`). O que
está trocado é só a camada de serviço: o config aponta `services/supabase` para
`.preview/mock-supabase-academico.js`.

## O que a página mostra

Os **seis padrões encontrados na consulta de 28/09/2026** (com matrículas
fictícias), mais os três desfechos que a tela precisa distinguir e que a amostra
não produziu:

- consulta **sem resultado** (a API respondeu e não achou);
- **falha de comunicação** (não se sabe nada);
- **nunca consultado** (a tela chama a Edge Function sozinha).

## Matrículas fictícias

`dados-academico.js` usa **matrículas fictícias** — nove dígitos, mesmo formato
das reais, começando por `99` (que não corresponde a ano de ingresso nenhum).
Nenhum nome, nenhum CPF, nenhum dado real de aluno.

**Correção de uma afirmação anterior.** A primeira versão deste arquivo usava as
matrículas reais dos seis alunos consultados e dizia que eram "informação
institucional, nenhum dado pessoal". Estava errado: a matrícula identifica uma
pessoa, e matrícula + curso + campus + turno + situação de alguém que está sendo
cobrado é dado pessoal, mesmo sem nome e sem CPF. Num arquivo versionado, isso é
espalhar dado pessoal para onde ele não precisa estar.

O que foi **preservado** é a estrutura, que é o que a tela precisa aguentar:
três vínculos com curso, campus e turno idênticos e status diferentes;
acentuação dividindo o mesmo curso; o mesmo curso literal com duas situações;
metade das linhas sem situação; e as duas divergências contra o CRM. Dado
inventado costuma sair mais limpo do que a realidade, e preview limpo não prova
nada — por isso a forma foi mantida fiel.

## Cuidado ao mexer no mock

- `prime_academico_ultima` devolve **`null`** para quem nunca foi consultado —
  é esse `null` que dispara a consulta automática. Devolver `{}` ou uma lista
  vazia mataria o caminho que o preview existe para mostrar.
- Devolve **objeto novo** a cada chamada (`structuredClone`), porque a RPC real
  também devolve. Reaproveitar a referência faria a tela parecer que não
  atualiza, e o "defeito" não existiria em produção.
- `functions.invoke` demora 1s de propósito, senão o "Consultando…" passa rápido
  demais para ser conferido.
- `from()` **estoura** em vez de fingir que deu certo: este bloco não escreve em
  tabela nenhuma, e se um dia alguém acrescentar uma escrita, o preview quebra
  na hora.

## Por que o config tem `root` explícito

`npx vite --config <caminho>` **não** muda a raiz. Sem `root`, o vite varre o
`index.html` e o `App.jsx` do checkout de onde o comando foi chamado, e a página
morre com dezenas de "Failed to resolve import ../services/supabase" — que
parecem defeito do componente e não são.
