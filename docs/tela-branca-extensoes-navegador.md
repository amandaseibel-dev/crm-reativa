# Tela branca no CRM: extensões e tradução do navegador

## O sintoma

A tela fica **branca** ao clicar em algo — abrir uma conversa na Central, trocar
de aluno, abrir um painel. No console do Chrome (`Cmd+Option+J`):

```
Uncaught NotFoundError: Failed to execute 'insertBefore' on 'Node':
The node before which the new node is to be inserted is not a child of this node.
```

Pode aparecer também como `removeChild` ou `The node to be removed is not a
child of this node`. É a mesma família.

## Por que acontece

O React guarda **referência direta** aos nós de texto que ele criou, para saber
onde inserir o próximo. Quando algo de fora troca esses nós — o tradutor
embrulha cada texto num `<font>`, uma extensão insere um `<span>` —, a
referência do React aponta para um nó que **não é mais filho daquele pai**.

Na próxima atualização o React tenta inserir ali, o navegador recusa, e a
exceção não é capturável pelo componente: derruba a árvore inteira.

**A aplicação não tem defeito.** O DOM foi alterado por baixo dela.

Quanto mais texto a tela troca de uma vez, maior a chance de colidir. Por isso a
Central foi a primeira a cair: abrir uma conversa troca dezenas de nós.

## Os causadores, em ordem de frequência

| | O que faz | Como reconhecer no console |
|---|---|---|
| **Google Translate** (nativo do Chrome) | envolve cada texto em `<font>` | `document.documentElement.className` contém `translated-ltr` |
| **Microsoft Translator** (Edge/extensão) | idem, com atributos próprios | existe elemento com `[_msttexthash]` |
| **Grammarly** | injeta overlay e marca o texto | existe `grammarly-extension` no DOM |
| **LanguageTool** | igual ao Grammarly | elemento `<lt-div>` |
| **Extensões de acessibilidade / leitor** | reescrevem texto para VLibras, dislexia, alto contraste | varia |
| **Extensões de cupom e "dark mode" genérico** | injetam nós dentro do conteúdo | varia |

### Diagnóstico em 10 segundos

No console (`Cmd+Option+J`), cole:

```js
({
  traduzido: document.documentElement.className,
  google: document.querySelectorAll('.goog-te-banner-frame, font[_mstmutation]').length,
  microsoft: document.querySelectorAll('[_msttexthash]').length,
  grammarly: document.querySelectorAll('grammarly-extension').length,
  languagetool: document.querySelectorAll('lt-div').length,
})
```

Qualquer valor diferente de zero (ou `translated-ltr` na primeira linha) aponta o
culpado.

## O que fazer — operador

**1. Confirme com janela anônima.** `Cmd+Shift+N`, entre no CRM e repita a ação.
Se funcionar na anônima e falhar na normal, é extensão ou tradução — a anônima
sobe sem extensões.

**2. Desligue a tradução deste site.** Botão direito na página →
**Traduzir para o português** → engrenagem → **Nunca traduzir este site**.
Ou em `chrome://settings/languages`, remova o CRM da lista de tradução
automática. Recarregue depois.

**3. Se persistir, desative extensões.** `chrome://extensions`, desligue todas,
recarregue o CRM. Voltando a funcionar, religue uma a uma até achar.

## O que já está protegido

O `index.html` declara `lang="pt-BR"`, `translate="no"` e
`<meta name="google" content="notranslate">`. Isso impede o Chrome de traduzir
por conta própria.

**Não resolve** o caso de quem já marcou *"traduzir sempre este site"* antes —
essa escolha fica salva no perfil do navegador e vence a marcação da página. Aí
é o passo 2 acima.

E **não protege** contra Grammarly, LanguageTool ou extensões de acessibilidade:
elas alteram o DOM de propósito, e nenhuma marcação da página as impede.

## Por que não colocamos um Error Boundary

Um Error Boundary esconderia a tela branca, mas o DOM continuaria corrompido. O
sintoma seguinte seria pior de diagnosticar: texto embaralhado, clique sem
efeito, campo que não atualiza. Prefere-se falhar visivelmente a falhar em
silêncio.

## Histórico

**20/08/2026** — a Central ficava branca ao abrir uma conversa. Descartados,
com evidência: RPC respondendo, dados sem nulos, render com as linhas reais
passando em teste headless, todas as `key` estáveis, e nenhuma manipulação
direta de DOM no código. O `index.html` declarava `lang="en"` numa aplicação em
português — o Chrome traduzia sozinho. Janela anônima funcionava.
