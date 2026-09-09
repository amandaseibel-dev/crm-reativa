-- A MATRICULA DO CRM NUNCA E A DO PRIME.
--
-- Medido em 09/09/2026 sobre revisao_prime_aluno: 13.810 alunos tem as duas
-- matriculas gravadas e em ZERO casos elas sao iguais. Nao e caso raro, e 100%.
-- Exemplo: Aghatta Machado da Silva e 180 no CRM e 2025001442 no Prime.
--
-- Consequencia medida:
--   alunos.matricula = prime_extrato.matricula  -> 0 linhas (de 388.446)
--   alunos.matricula = pagamentos.matricula     -> 0 linhas
--   alunos.cpf       = prime_extrato.cpf        -> 387.505 (99,8%)
--
-- Um join errado aqui nao da erro: devolve vazio. E o tipo de defeito que so
-- aparece quando alguem estranha um numero baixo demais, meses depois.
-- Os Edge Functions (prime-sync, prime-cadastro) ja fazem certo: buscam por CPF
-- e usam a `registration` que a propria API devolve. Estes comentarios sao para
-- o proximo que for escrever a consulta.

comment on column public.alunos.matricula is
  'Matricula INTERNA do CRM. NAO e a do Prime -- em 13.810 alunos conferidos, ZERO coincidem. Para falar com o Prime use o CPF: e a unica chave que casa (99,8%).';

comment on column public.prime_extrato.matricula is
  'Registration do PRIME (a mesma de prime_contratos.registration), apesar do nome. NUNCA junte com alunos.matricula: o join devolve zero linhas, sem erro.';

comment on column public.pagamentos.matricula is
  'Quando preenchida, e a registration do PRIME, nao a matricula do CRM. Junte por cpf ou aluno_id.';
