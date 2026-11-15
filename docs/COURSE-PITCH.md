# Course proposal slide text

Copy each section into a slide. Replace the bracketed fields before presenting. **Doctor Practice Management System** is the working title.

## 1. Doctor Practice Management System

**Appointment booking and live queues for doctors’ chambers**

[Course code and title]  
Project Proposal  
[Presentation date]

## 2. Team Members

[Group or section]

- [Member name] ([Student ID])
- [Add the remaining team members]

## 3. Motivation

- Patients who book by phone or at the reception desk may have to call again to find out when their turn is approaching.
- When a patient misses their turn or staff move someone forward, a booking serial alone cannot tell patients the current serving order.
- Doctors and assistants need a shared view of who is waiting, who is being seen, and who has missed their turn.

## 4. Project Objective

- Build a web app for booking appointments and managing the consultation queue in a doctor’s chamber.
- Give patients a live view of anonymous booking serials and an estimated wait for their own turn.
- Let doctors and assistants manage the queue as the session changes.

**Expected outcome**  
A working prototype that demonstrates booking, live queue management, and session closure using sample patients.

## 5. Initial Scope

- One chamber and up to one assistant per doctor.
- Staff publish dated sessions with consultation hours and booking capacity.
- Patients book online, and staff can register and book patients who contact the chamber directly.
- Demonstrate with sample data. Prescriptions, clinical records, online payments, and queue SMS alerts are future work.

## 6. Major Functional Requirements for Patients

- View published consultation sessions and their availability.
- Book an available session or cancel an eligible booking.
- Follow the current consultation and waiting order through anonymous serials.
- See the status of their own booking and an estimated wait for their turn.

## 7. Major Functional Requirements for Staff and Administrators

- **Doctor and assigned assistant** can publish sessions, register patients, and manage bookings.
- **Doctor and assigned assistant** can call the next patient, finish a consultation, mark or restore a missed turn, and reorder waiting slots.
- **Doctor** can invite or revoke an assistant’s access.
- **System administrator** manages doctor practice access.

## 8. Breakdown of the Problem

1. **Accounts and access** — Activate accounts and enforce permissions for each role.
2. **Scheduling and booking** — Publish sessions, check capacity, and assign unique serials within each session.
3. **Queue management** — Track the current consultation and update the waiting order.
4. **Wait estimates** — Use the configured consultation duration and the number of patients ahead.
5. **Live views** — Refresh patient and staff screens after queue changes.

**Planned demo**  
Publish a session → book sample patients → call the next patient → mark and restore a missed turn → show the updated patient view → finish the consultation and close the session.

## 9. Work Plan and Current Status

| Phase | Deliverable | Status |
| --- | --- | --- |
| Foundation | Web app shell, API, and local database connectivity | Implemented and verified |
| Accounts and access | Sign-in, account activation, and staff permissions | Planned next |
| Scheduling and booking | Session publishing, booking capacity, and cancellations | Planned |
| Queue engine | Queue operations, wait estimates, and audit history | Planned |
| Live demo and verification | Role-specific screens, live updates, and end-to-end testing | Planned |

## 10. Major Stakeholders

- **Patients** book visits and follow their turn remotely.
- **Doctors** publish sessions and manage consultations.
- **Chamber assistants** register patients and coordinate the waiting queue.
- **System administrators** manage access to doctor practices.

## 11. Hardware, Software and Tools

| Category | Technology |
| --- | --- |
| User devices | Phone or computer with a web browser |
| Frontend | Next.js and React |
| Backend | Node.js, Express, and TypeScript |
| Database | MongoDB replica set |
| Live updates | Server-Sent Events with polling as a fallback |
| Validation and testing | Zod, Vitest, and Supertest |
| Development tools | Git, pnpm, and Turborepo |

## 12. Critical Challenges and Trade-offs

| Challenge | Design decision |
| --- | --- |
| Two people try to book the last slot, or two staff members call the next patient at once. | Use database transactions and queue version checks to prevent overbooking or overlapping consultations. |
| Staff need to adjust the queue while patients need a stable booking reference. | Keep the booking serial fixed and update the serving position independently. |
| Patients need queue visibility while personal details need protection. | Show anonymous serials in the patient view. Restrict patient details to authorized users. |
| Family members may share a contact phone. | Give each patient a separate account and a permanent patient ID. |
| Consultations vary in length. | Display a wait estimate based on the current queue and update it as the session progresses. |

## 13. Thank You

**Q&A**

How can we make waiting for a consultation more predictable while giving chamber staff control of the queue?
