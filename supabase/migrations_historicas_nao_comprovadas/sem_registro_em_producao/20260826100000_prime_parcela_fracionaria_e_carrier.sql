-- Dois consertos na coleta Prime, achados rodando em producao (26/08/2026).
--
-- 1) A PARCELA PRECISA ACEITAR FRACAO -- e o bug que custou cinco horas.
--
-- O numero da parcela sai dos tres ultimos digitos do `documentNumber`
-- divididos por 100:
--
--     ...0100 -> 1        ...0600 -> 6        ...0990 -> 9,9
--
-- A coluna e o cast eram `integer`, e o Postgres recusava com "invalid input
-- syntax for type integer: 9.9". Como a gravacao e por aluno, UM titulo assim
-- abortava o aluno INTEIRO. Quando a fila chegou numa faixa cheia desses
-- documentos, virou 55 erros a cada 60 alunos -- por cinco horas, batendo na
-- API da Ulbra e gravando zero, sem erro visivel em lugar nenhum: a funcao de
-- coleta so contava "erros", sem dizer o motivo.
--
-- Numeric em vez de arredondar: 9,9 virar 10 inventaria uma parcela que nao
-- existe, e esse numero e usado para casar com a nossa cobranca.
--
-- 2) O PORTADOR DE CADA TITULO.
--
-- A regra da Amanda -- 195 cobra, 166 saiu da cobranca -- so vale se souber o
-- portador do BOLETO. A lista que temos e por CPF, e o portador acompanha a
-- MATRICULA: 542 alunos aparecem nos dois ao mesmo tempo, o que so acontece
-- com quem tem uma matricula paga e outra devendo.
--
-- RESSALVA MEDIDA: nos primeiros 787 titulos coletados com o campo, o 166 NAO
-- apareceu nenhuma vez (181 no 195, 606 em outras agencias). Bate com o que ja
-- se sabia: a API mostra QUEM esta no 166, nunca as parcelas dele. Entao este
-- campo NAO separa "pagou" de "deve" -- serve para outra coisa, igualmente
-- necessaria: descartar pagamento feito a TERCEIRO (carrier 95, 177...), que
-- hoje a conferencia casaria como se fosse pagamento da nossa divida.

alter table public.prime_titulo_semestre
  alter column parcela type numeric(6,2) using parcela::numeric;

comment on column public.prime_titulo_semestre.parcela is
  'Numero da parcela = 3 ultimos digitos do documentNumber / 100. Numeric porque a Ulbra emite documento terminado em 990, que da 9,9 -- e quando isto era integer, um documento assim derrubava a gravacao do aluno inteiro.';

alter table public.prime_titulo_semestre
  add column if not exists carrier_id integer;

comment on column public.prime_titulo_semestre.carrier_id is
  'Portador do titulo na Ulbra: 195 = mensalidade em cobranca, 166 = saiu da cobranca, outros = agencia de terceiro. Nulo = coletado antes de 26/08/2026.';

create index if not exists ix_prime_titulo_carrier
  on public.prime_titulo_semestre (carrier_id)
  where carrier_id is not null;
