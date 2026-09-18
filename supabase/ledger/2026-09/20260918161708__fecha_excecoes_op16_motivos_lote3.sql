do $op$
declare r record; v_n int := 0;
begin
  for r in select * from (values
    ('50718020001', 'DIVERGENCIA_FINANCEIRA_AGUARDA_GESTAO 18/09: base sem honorario acima do valor corrigido do Prime; margem excepcional NAO autorizada pela Amanda. Nao baixar.'),
    ('50721410001', 'DIVERGENCIA_FINANCEIRA_AGUARDA_GESTAO 18/09: base sem honorario acima do valor corrigido do Prime; margem excepcional NAO autorizada pela Amanda. Nao baixar.'),
    ('50716450001', 'AGUARDA_CONFERENCIA_PRIME_GRUPO_A 18/09: margem autorizada pela Amanda, mas o titulo entrou na Conferencia Prime (A1 PENDENTE) as 15:43; decisao pertence ao Grupo A. Nao executado.'),
    ('50716720001', 'AGUARDA_CONFERENCIA_PRIME_GRUPO_A 18/09: margem autorizada pela Amanda, mas o titulo entrou na Conferencia Prime (A2_NAO_COBRE) as 15:43; decisao pertence ao Grupo A. Nao executado.'),
    ('50717060001', 'AGUARDA_CONFERENCIA_PRIME_GRUPO_A 18/09: margem autorizada pela Amanda, mas o titulo entrou na Conferencia Prime (A1 PENDENTE) as 15:43; decisao pertence ao Grupo A. Nao executado.'),
    ('50717460001', 'AGUARDA_CONFERENCIA_PRIME_GRUPO_A 18/09: margem autorizada pela Amanda, mas o titulo entrou na Conferencia Prime (A1 PENDENTE) as 15:43; decisao pertence ao Grupo A. Nao executado.'),
    ('50717870001', 'AGUARDA_CONFERENCIA_PRIME_GRUPO_A 18/09: margem autorizada pela Amanda, mas o titulo entrou na Conferencia Prime (A1 PENDENTE) as 15:43; decisao pertence ao Grupo A. Nao executado.'),
    ('50716580001', 'AGUARDA_CONFERENCIA_PRIME_GRUPO_A 18/09: registro autorizado pela Amanda preservando BAIXA_REALIZADA, mas o titulo 4521350 esta EM_CONFIRMACAO na Conferencia Prime (A1 PENDENTE, corroboracao PAGAMENTO_REATIVA); registrar agora concorreria com o Grupo A. Nao executado.')
  ) v(boleto, texto) loop
    update public.fila_pagamento_sem_vinculo f
       set observacao = coalesce(f.observacao,'') || case when coalesce(f.observacao,'') = '' then '' else ' | ' end || r.texto
     where ltrim(f.boleto,'0') = r.boleto and f.decisao is null;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'OP16_ABORTADA: boleto % nao tem exatamente 1 pendencia aberta (%)', r.boleto, v_n; end if;
  end loop;
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values ('fechamento_pagamentos_20260918', 'MOTIVOS_LOTE3', 'fila_pagamento_sem_vinculo',
          jsonb_build_object('op', 16, 'divergencia', jsonb_build_array('50718020001','50721410001'),
                             'grupo_a', jsonb_build_array('50716450001','50716720001','50717060001','50717460001','50717870001','50716580001')));
end
$op$;