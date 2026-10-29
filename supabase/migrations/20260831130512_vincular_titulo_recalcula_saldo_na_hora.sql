-- Vincular mensalidade a acordo passa a tirar do saldo NA HORA.
--
-- Amanda, 31/08: "isso que nao pode acontecer, vincular precisa sair do saldo
-- em aberto".
--
-- O DEFEITO. `vincular_titulos_acordo` grava o vinculo e NAO recalcula o aluno.
-- Ate a virada das 06:00 o saldo seguia somando a mensalidade que acabou de ser
-- ligada ao acordo -- e a mesma divida contava duas vezes: uma na parcela do
-- acordo, outra no titulo.
--
-- Visto ao vivo na Sarah Oleszko Lemes: ela vinculou as 13:01:54 e o saldo
-- continuou em R$ 20.527,82, que e 7.605,58 (parcelas do acordo) + 12.922,24
-- (as quatro mensalidades ja vinculadas). Depois do recalculo: R$ 7.605,58.
-- O vinculo dela estava certo desde o inicio -- faltava o recalculo.
--
-- POR COMANDO, NAO POR LINHA. Vincular um acordo mexe em varios titulos de uma
-- vez; recalcular o mesmo aluno uma vez por titulo seria desperdicio. Com
-- `referencing new table`, cada aluno e recalculado UMA vez por comando, por
-- mais titulos que ele tenha.
--
-- Cobre INSERT (vincular) e UPDATE (desvincular pelo `ativo=false`) -- os dois
-- mudam o saldo, nos dois sentidos.
--
-- O `exception when others` existe para que uma falha no recalculo nunca impeca
-- o vinculo de ser gravado. O pior caso volta a ser o de hoje -- saldo velho ate
-- as 06:00 -- e nao perder a ligacao.
--
-- Testado em prod com rollback: inserir um vinculo derrubou o saldo do aluno em
-- R$ 1.453,76 no mesmo comando.
--
-- DESFAZER: supabase/rollbacks/20260831180000_vincular_titulo_recalcula_saldo_na_hora.rollback.sql

create or replace function public._trg_recalc_por_vinculo_novo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record;
begin
  for r in
    select distinct t.aluno_id
      from novas n
      join public.acordos_titulos t on t.id = n.titulo_id
     where t.aluno_id is not null
  loop
    begin
      perform public.recalcular_situacao_aluno(r.aluno_id, 'vinculo_titulo');
    exception when others then null;
    end;
  end loop;
  return null;
end;
$function$;

drop trigger if exists trg_recalc_vinculo_ins on public.acordo_titulo_vinculo;
create trigger trg_recalc_vinculo_ins
after insert on public.acordo_titulo_vinculo
referencing new table as novas
for each statement execute function public._trg_recalc_por_vinculo_novo();

drop trigger if exists trg_recalc_vinculo_upd on public.acordo_titulo_vinculo;
create trigger trg_recalc_vinculo_upd
after update on public.acordo_titulo_vinculo
referencing new table as novas
for each statement execute function public._trg_recalc_por_vinculo_novo();
