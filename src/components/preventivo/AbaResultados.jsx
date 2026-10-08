// Aba Resultados do Preventivo.
//
// A tela responde três perguntas e para por aí: quanto a carteira tinha quando
// começamos, quanto ela caiu, e quanto sobrou. Depois, o que mudou depois de
// cada envio.
//
// A FONTE É O RELATÓRIO IMPORTADO, e só ele. Nada aqui consulta o Prime: a
// comparação é entre fotos do próprio relatório, que é o que a operação tem em
// mãos todo dia. Os objetos de sincronização continuam no banco e nos outros
// módulos — apenas não aparecem nesta aba.
//
// A PALAVRA É "REDUÇÃO DO SALDO APÓS A AÇÃO". Movimento observado entre duas
// fotos. Não é pagamento confirmado: o título sumiu do relatório, e a fonte não
// diz por quê.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { S } from "../../ui/estilosFila";
import PainelPreventivo from "./PainelPreventivo";

export default function AbaResultados({ carteira }) {
  const [painel, setPainel] = useState(null);
  const [erro, setErro] = useState("");

  const buscar = useCallback(
    () => supabase.rpc("preventivo_painel", { p_carteira_id: carteira.id }),
    [carteira.id]);

  useEffect(() => {
    let vivo = true;
    buscar().then(({ data, error }) => {
      if (!vivo) return;
      if (error) { setErro(error.message); return; }
      setErro(""); setPainel(data);
    });
    return () => { vivo = false; };
  }, [buscar]);

  if (erro) return <div style={S.erroBox}>{erro}</div>;
  if (!painel) return <p style={S.muted}>Carregando…</p>;

  return <PainelPreventivo dados={painel} />;
}
