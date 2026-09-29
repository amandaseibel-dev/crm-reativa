# Preview da seção "Situação acadêmica consultada no Prime"

```bash
npx vite --config vite.preview-academico.config.js
# abre http://localhost:5198/preview-academico.html
```

O **componente é o real** (`src/components/SituacaoAcademicaPrime.jsx`). O que
está trocado é só a camada de serviço: o config aponta `services/supabase` para
`.preview/mock-supabase-academico.js`.

## O que a página mostra

Os **seis alunos consultados no Prime em 28/09/2026**, mais os três desfechos
que a tela precisa distinguir e que a amostra não produziu:

- consulta **sem resultado** (a API respondeu e não achou);
- **falha de comunicação** (não se sabe nada);
- **nunca consultado** (a tela chama a Edge Function sozinha).

## Dado real, sem dado pessoal

`dados-academico.js` tem matrícula, curso, campus, turno e situação — informação
institucional. **Nenhum nome e nenhum CPF.**

É dado real de propósito. O que esta tela precisa provar é que aguenta o formato
que a API realmente devolve: três vínculos indistinguíveis com status
diferentes, acentuação dividindo o mesmo curso, metade das linhas sem situação.
Dado inventado sempre sai mais limpo do que a realidade, e um preview limpo não
prova nada.

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
