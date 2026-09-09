# Padrão de cadastro

Regra de casa para criar e identificar aluno no CRM ReATIVA. Vale para tela,
importação, script de correção e rotina automática — sem exceção por ser
"só um ajuste rápido".

A premissa que manda em tudo, definida pela Amanda em 08/09/2026:

> **Um CPF por aluno, sempre. Se o aluno tem dois cursos, isso vira um campo
> mostrando os dois — nunca uma segunda ficha.**

---

## As seis regras

### 1. O CPF é a identidade. Só ele.

Identificar aluno é resolver pelo **CPF limpo** — só dígitos,
`regexp_replace(cpf, '\D', '', 'g')`, com zeros à esquerda preservados.

Nunca por nome. Nome tem acento, abreviação, erro de digitação e homônimo. A base
tem hoje `Aígo Silva` × `Aígo Silva`, `Aline Rodirgues Dias` × `Aline Rodrigues
Dias`, `Carolini Pereira Tatsch` × `Carolini Pereira Pereira` — todos a mesma
pessoa, todos com ficha separada por causa do nome.

Vale também para dinheiro: **baixa se dá pelo número do título, nunca pelo nome
do pagador** — o nome no extrato é de quem pagou, que muitas vezes não é o aluno.

### 2. Uma ficha aberta por aluno.

Um aluno tem no máximo **um caso não encerrado**. Se já existe, o caminho é
acordar o caso existente, jamais criar outro.

Isso é garantido em duas camadas: o gatilho
`trg_zz_caso_nao_duplica_aluno` (que dá a mensagem legível) e o índice único
`ux_casos_uma_ficha_aberta_por_aluno` (que garante fisicamente). Se o código
recebe `ALUNO_JA_TEM_CASO_ABERTO`, **isso não é um erro para contornar** — é a
regra funcionando. A correção é abrir o caso que já existe.

### 3. Dois cursos são um campo, não uma ficha.

Aluno em dois cursos ou duas unidades continua sendo um CPF e uma ficha. Os
cursos aparecem como atributo.

Casos reais na base: Isabela de Oliveira Peyrot (Medicina Veterinária/Canoas e
Graduação Presencial/Palmas) e Franck Gasparoni (Medicina/Canoas e Graduação
Presencial/Canoas). São duas matrículas da mesma pessoa — uma ficha só.

### 4. Sem CPF não nasce ficha.

Importação sem CPF **não cria aluno**. O registro fica em quarentena aguardando
vínculo manual.

É daí que vieram as **fichas fantasma**: cadastros sem CPF, sem caso e sem
acordo, que só servem de cabide para pagamento. Em 08/09 havia 34 delas
segurando 56 pagamentos — R$ 89.988,24 que a pessoa pagou e não apareceu na
ficha que a cobra. A importação SANTANDER, que vem sem CPF, é a origem
conhecida.

### 5. Duplicidade se sinaliza, não se apaga.

Encontrou possível duplicata: **marque e mande para conferência**. Nunca apague,
nunca funda automático.

Dois motivos medidos:

- Apagar por "número de título repetido" apagaria **4.706 lançamentos legítimos,
  R$ 3.396.985,41** — porque um título parcelado é pago várias vezes. A chave de
  duplicidade é **título + parcela**, nunca o título sozinho.
- O mesmo CPF em duas pessoas diferentes existe na base (3 casos). Fundir
  juntaria a dívida de gente que não tem relação — e cobrar quem não deve é
  problema de LGPD, não de número.

### 6. Fundir ficha é mover histórico, não apagar cadastro.

Quando a fusão é legítima (mesma pessoa, mesmo CPF), o procedimento é:

1. Copiar o de/para registro a registro numa tabela `_backup_*` com RLS
   deny-all;
2. Repontar pagamentos, acordos, títulos, contatos e movimentações para a ficha
   que fica;
3. Conferir o saldo do aluno **antes e depois** — se mudou, pare e investigue;
4. Marcar a ficha absorvida, nunca deletar.

Executado assim em 08/09: 14 pagamentos (R$ 23.609,95) e 3 acordos quitados
(R$ 7.992,20) voltaram para o dono, com saldo idêntico antes e depois nos 5
alunos.

---

## Como cada regra é garantida

| Regra | Garantia | Estado |
|---|---|---|
| 2. Uma ficha aberta por aluno | gatilho + índice único parcial | nesta migration |
| 1. CPF é a identidade | resolução por `cpf_limpo` no código | em uso |
| 4. Sem CPF não nasce ficha | quarentena na importação | **a fazer** |
| 1. CPF único em `alunos` | índice único parcial em `cpf_limpo` | **bloqueado** (ver abaixo) |
| 3. Dois cursos | campo de cursos na ficha | **a fazer** |

### O que ainda bloqueia o CPF único em `alunos`

Em 08/09 havia **11 CPFs com mais de uma ficha**, em três famílias que precisam
de tratamentos diferentes:

- **6 — ficha vazia sobrando.** Mesma pessoa. Fusão pela regra 6. *(5 já
  tratadas em 08/09; Maria do Socorro ficou de fora porque as duas fichas têm
  R$ 2.249,67 — pode ser dívida duplicada, não fusão.)*
- **2 — dois cursos reais.** Viram campo pela regra 3.
- **3 — pessoas diferentes com o mesmo CPF.** Correção de cadastro. Não funde.

Enquanto esses casos existirem, o índice único em `cpf_limpo` não pode ser
criado — ele falharia sobre os dados atuais. A ordem é: resolver as três
famílias, depois instalar a garantia.
