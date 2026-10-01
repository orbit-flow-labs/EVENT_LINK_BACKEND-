import { Router } from 'express';
import { StrKey } from '@stellar/stellar-sdk';
import { Ticket } from '../models/Ticket';
import { inMemoryStore, isConnectedToMongo } from '../db';
import {
  sendPurchaseConfirmationEmail,
  sendClaimConfirmationEmail,
  sendGateCheckinEmail,
} from '../services/emailService';

const router = Router();
const SOROBAN_CONTRACT_ID = process.env.SOROBAN_CONTRACT_ID || 'CDD3VJENDGV6LLOY2OCYQSRD5CQKYAPL4I3MNWFFQBXJ6P6KOJHQK47J';
const amountPatterns = {
  stripe: /^\$\d{1,9}(?:\.\d{1,2})? USD$/,
  flutterwave: /^₦(?:\d+|\d{1,3}(?:,\d{3})+) NGN$/,
  stellar: /^\d{1,12}(?:\.\d{1,7})? XLM$/,
};

export function mergeTicketRecords(memoryTickets: any[], databaseTickets: any[]): any[] {
  const ticketsById = new Map<string, any>();
  memoryTickets.forEach((ticket) => ticketsById.set(ticket.id, ticket));
  databaseTickets.forEach((ticket) => {
    const record = typeof ticket.toObject === 'function' ? ticket.toObject() : ticket;
    ticketsById.set(record.id, record);
  });
  return Array.from(ticketsById.values());
}

// 1. Purchase Ticket Endpoint
router.post('/purchase', async (req, res) => {
  try {
    const { eventId, eventTitle, eventDate, eventVenue, tierName, buyerName, buyerEmail, paymentProvider, amountPaid } = req.body;

    if (typeof buyerName !== 'string' || !buyerName.trim() || buyerName.trim().length > 100) {
      return res.status(400).json({ error: 'A name between 1 and 100 characters is required.' });
    }
    if (typeof buyerEmail !== 'string' || buyerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail.trim())) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    const amountPattern = typeof paymentProvider === 'string'
      ? amountPatterns[paymentProvider as keyof typeof amountPatterns]
      : undefined;
    if (!amountPattern || typeof amountPaid !== 'string' || !amountPattern.test(amountPaid)) {
      return res.status(400).json({ error: 'A valid payment provider and matching amount are required.' });
    }

    const id = `EVTLNK-${Math.floor(100000 + Math.random() * 900000)}`;
    const ticketHash = `EVTHASH-${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()).join('')}`;
    const claimCode = `CLAIM-${Math.floor(100000 + Math.random() * 900000)}`;
    const custodialPublicKey = `GCKEY${Array.from({ length: 48 }, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()).join('')}`;

    const ticketData = {
      id,
      ticketHash,
      eventId: eventId || 'evt-101',
      eventTitle: eventTitle || 'DRIPS Soroban Summit',
      eventDate: eventDate || 'October 20-22, 2026',
      eventVenue: eventVenue || 'Lagos Convention Center',
      tierName: tierName || 'General Pass',
      buyerName: buyerName.trim(),
      buyerEmail: buyerEmail.trim(),
      paymentProvider,
      amountPaid,
      custodialPublicKey,
      currentOwnerAddress: custodialPublicKey,
      status: 'claimable',
      stellarTxHash: `tx_${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`,
      sorobanContractId: SOROBAN_CONTRACT_ID,
      claimCode,
      claimUrl: `${req.headers.origin || 'http://localhost:5179'}/?claimCode=${claimCode}`,
    };

    inMemoryStore.tickets.set(id, ticketData);

    if (isConnectedToMongo) {
      try {
        const newTicket = new Ticket(ticketData);
        await newTicket.save();
      } catch (err) {
        console.warn('MongoDB ticket save warning, relying on in-memory store:', err);
      }
    }

    // Trigger purchase & minting progress email
    const emailSent = await sendPurchaseConfirmationEmail(ticketData.buyerEmail, ticketData.buyerName, ticketData);

    return res.status(201).json({
      message: 'Ticket purchased & minted on Stellar Testnet successfully.',
      ticket: ticketData,
      emailSent,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Ticket purchase failed' });
  }
});

// 2. Claim Ticket Endpoint
router.post('/claim', async (req, res) => {
  try {
    const { claimCode, walletAddress } = req.body;

    if (typeof claimCode !== 'string' || !claimCode.trim()) {
      return res.status(400).json({ error: 'A claim code is required.' });
    }
    if (typeof walletAddress !== 'string' || !StrKey.isValidEd25519PublicKey(walletAddress)) {
      return res.status(400).json({ error: 'A valid Stellar public key is required.' });
    }

    let ticket: any = null;

    if (isConnectedToMongo) {
      ticket = await Ticket.findOneAndUpdate(
        { claimCode, status: 'claimable' },
        { $set: { status: 'valid', currentOwnerAddress: walletAddress } },
        { new: true },
      );

      if (!ticket) {
        const existingTicket = await Ticket.exists({ claimCode });
        return res.status(existingTicket ? 409 : 404).json({
          error: existingTicket ? 'Ticket has already been claimed.' : 'Ticket claim code not found.',
        });
      }

      inMemoryStore.tickets.set(ticket.id, ticket);
    } else {
      ticket = Array.from(inMemoryStore.tickets.values()).find((storedTicket) => storedTicket.claimCode === claimCode);

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket claim code not found.' });
      }
      if (ticket.status !== 'claimable') {
        return res.status(409).json({ error: 'Ticket has already been claimed.' });
      }

      ticket.status = 'valid';
      ticket.currentOwnerAddress = walletAddress;
      inMemoryStore.tickets.set(ticket.id, ticket);
    }

    const emailToUse = ticket.buyerEmail;
    const nameToUse = ticket.buyerName || 'Valued Attendee';

    // Trigger claim progress email
    const emailSent = emailToUse
      ? await sendClaimConfirmationEmail(emailToUse, nameToUse, ticket, walletAddress)
      : false;

    return res.json({
      message: 'Ticket claimed successfully to self-custody wallet on Stellar.',
      ticket,
      emailSent,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Ticket claim failed' });
  }
});

// 3. Dispatch Progress Email Endpoint (Generic handler for frontend events)
router.post('/send-progress-email', async (req, res) => {
  try {
    const { stage, email, fullName, ticket, walletAddress, terminalId } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Recipient email is required' });
    }

    let success = false;
    const recipientName = fullName || 'EventLink Attendee';

    if (stage === 'purchase') {
      success = await sendPurchaseConfirmationEmail(email, recipientName, ticket || { eventTitle: 'Event Pass', id: 'TCK-MINTED' });
    } else if (stage === 'claim') {
      success = await sendClaimConfirmationEmail(email, recipientName, ticket || { eventTitle: 'Event Pass' }, walletAddress || 'G...STELLAR');
    } else if (stage === 'checkin') {
      success = await sendGateCheckinEmail(email, recipientName, ticket || { eventTitle: 'Event Pass' }, terminalId || 'GATE-TERMINAL-01');
    }

    return res.json({ success, message: `Progress email [${stage}] sent to ${email}` });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to dispatch progress email' });
  }
});

// 4. Get All Tickets
router.get('/', async (_req, res) => {
  try {
    const memoryList = Array.from(inMemoryStore.tickets.values());
    if (isConnectedToMongo) {
      const dbTickets = await Ticket.find().sort({ createdAt: -1 });
      const ticketsById = new Map(memoryList.map((ticket) => [ticket.id, ticket]));
      dbTickets.forEach((ticket) => ticketsById.set(ticket.id, ticket));
      return res.json(Array.from(ticketsById.values()));
    }
    return res.json(memoryList);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to retrieve tickets' });
  }
});

export default router;
