-- ============================================================================
-- ROLLBACK de 20261006161500 -- devolve a chave 'magic' ao comparativo e o
-- rótulo "Magic Number" ao card de julho, dentro de tv_snapshot_calcular().
-- ============================================================================
-- Mesmo patch ancorado da migration, na direção inversa: lê o corpo VIVO com
-- pg_get_functiondef, troca só os dois trechos e aborta se alguma âncora não
-- aparecer exatamente uma vez.
--
-- NÃO desfaz 20261006152000: magic_number_mensal, a chave 'magic' do payload e
-- as telas continuam como estão. Isto aqui mexe só em dois textos.
--
-- USAR ISTO SÓ FAZ SENTIDO se algum consumidor externo depender de
-- metas[].id = 'magic' ou do rótulo antigo do card de julho. Dentro do CRM não
-- depende: metas[].id serve de chave de lista em TelaMetas e do filtro que tira
-- o 'marco', e o rótulo de julho é texto puro.
-- ============================================================================

do $patch$
declare
  v_src  text;
  v_novo text;
  v_trocas text[][] := array[
    array[
      $a$public._tv_meta_obj('superar_mes_anterior','Superar o mês passado'$a$,
      $a$public._tv_meta_obj('magic','Superar o mês passado'$a$
    ],
    array[
      $a$public._tv_meta_hist('Superação de julho', 500000, v_hon)$a$,
      $a$public._tv_meta_hist('Magic Number', 500000, v_hon)$a$
    ]
  ];
  v_de text; v_para text; v_n int; i int;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular'
   limit 1;

  if v_src is null then
    raise exception 'tv_snapshot_calcular() nao existe neste banco — nada a reverter.';
  end if;

  v_novo := v_src;

  for i in 1 .. array_length(v_trocas, 1) loop
    v_de   := v_trocas[i][1];
    v_para := v_trocas[i][2];
    v_n := (length(v_novo) - length(replace(v_novo, v_de, ''))) / length(v_de);

    if v_n <> 1 then
      if (length(v_novo) - length(replace(v_novo, v_para, ''))) / length(v_para) = 1 then
        raise notice 'reversao % ja aplicada; seguindo.', i;
        continue;
      end if;
      raise exception
        'ancora % encontrada % vez(es) em tv_snapshot_calcular (esperado 1). Nada foi alterado. Trecho: %',
        i, v_n, left(v_de, 60);
    end if;

    v_novo := replace(v_novo, v_de, v_para);
  end loop;

  if v_novo = v_src then
    raise notice 'tv_snapshot_calcular ja estava no estado anterior; nada a fazer.';
    return;
  end if;

  execute v_novo;
end
$patch$;
