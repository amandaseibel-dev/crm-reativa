-- Acrescenta a checagem nova ao vigia sem reescrever as outras 14: pega a
-- definicao atual da funcao e injeta o ramo antes do `else`.
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.invariantes_rodar(text)'::regprocedure);

  if position('reabertura_de_ficha_barrada' in d) > 0 then
    return;
  end if;

  d := replace(d,
    '      else v_n := 0;',
    '      when ''reabertura_de_ficha_barrada'' then
        select count(*) into v_n from public.ficha_reabertura_barrada b
         where b.em > now() - interval ''24 hours'';

      else v_n := 0;');

  if position('reabertura_de_ficha_barrada' in d) = 0 then
    raise exception 'MIGRATION ABORTADA: nao achei o ponto de insercao no corpo de invariantes_rodar.';
  end if;

  execute d;
end
$mig$;
