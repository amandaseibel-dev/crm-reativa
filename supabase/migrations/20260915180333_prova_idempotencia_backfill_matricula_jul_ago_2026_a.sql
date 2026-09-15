-- PROVA DE IDEMPOTENCIA, em producao.
--
-- Repete EXATAMENTE a mesma chamada do lote ja aplicado. O esperado e
-- `JA_APLICADO` com zero alteracoes: o motor trava o lote, encontra o registro
-- em `backfill_matricula_lotes` com o mesmo hash e retorna antes de tocar em
-- qualquer coisa -- antes da stage, antes da trilha, antes do UPDATE.
--
-- Nao carrega dado pessoal: so lote, hash e quantidade.
--
-- O bloco abaixo levanta excecao se o resultado NAO for JA_APLICADO com zero
-- alteracoes -- assim a prova falha alto, em vez de passar silenciosa.

do $prova$
declare v jsonb;
begin
  v := public.backfill_matricula_aplicar(
         'MATRICULA_SANTANDER_JUL_AGO_2026_A',
         '168e0a880f94536bee942bc018661f8c',
         7401);

  if v->>'resultado' <> 'JA_APLICADO' then
    raise exception 'esperado JA_APLICADO, veio %', v->>'resultado';
  end if;
  if (v->>'alteracoes')::int <> 0 then
    raise exception 'esperado 0 alteracoes, veio %', v->>'alteracoes';
  end if;
  if (v->>'quantidade_aplicada')::int <> 7401 then
    raise exception 'o lote devia registrar 7401 aplicadas, registrou %', v->>'quantidade_aplicada';
  end if;

  -- e a trilha nao pode ter ganho linha
  if (select count(*) from public.backfill_matricula_lotes
       where lote = 'MATRICULA_SANTANDER_JUL_AGO_2026_A') <> 1 then
    raise exception 'o lote duplicou na auditoria';
  end if;
  if (select count(*) from public.backfill_matricula_origem
       where lote = 'MATRICULA_SANTANDER_JUL_AGO_2026_A') <> 7401 then
    raise exception 'a trilha por pagamento mudou de tamanho';
  end if;

  raise notice 'idempotencia confirmada: % ', v::text;
end $prova$;